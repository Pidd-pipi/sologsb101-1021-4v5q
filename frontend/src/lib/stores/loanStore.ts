/**
 * 借展点交 store（Svelte writable / derived）
 * 维护借展批次与借展条目；所有点交 / 归还 / 结清都在 Dexie 读写事务内完成：
 * - 点交时在事务内重读印石做 compare-and-swap，多标签并发点交时后提交者检测到
 *   「已被借出」即整批拒绝（事务回滚），不覆盖先完成的借出；
 * - 任一写入失败整批恢复，UI 保留原清单可重试。
 * 借出期间印稿 / 工序 / 钤印记录锁定（只读）。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db } from '$lib/utils/db';
import { loadStones, stones } from '$lib/stores/stoneStore';
import { GRADE_WEIGHT, type Grade } from '$lib/types/impression';
import type { Catalog } from '$lib/types/catalog';
import type { Design } from '$lib/types/design';
import type {
  LoanBatch,
  LoanItem,
  LoanItemStatus,
  LoanSnapshotItem,
} from '$lib/types/loan';

/** 并发点交冲突：后提交批次检测到印石已被借出（或未收录 / 不存在）时抛出，整批回滚 */
export class LoanConflictError extends Error {
  /** 冲突的印石 id 列表 */
  conflictStoneIds: string[];
  constructor(message: string, conflictStoneIds: string[] = []) {
    super(message);
    this.name = 'LoanConflictError';
    this.conflictStoneIds = conflictStoneIds;
  }
}

export interface CreateLoanInput {
  borrower: string;
  eventName: string;
  expectedReturnDate: string;
  note: string;
  stoneIds: string[];
}

export interface ReturnItemInput {
  itemId: string;
  /** 是否有缺损：有则列入「待处理」，无则正常归还 */
  hasDamage: boolean;
  damage: string;
  maintenance: string;
}

export const loanBatches = writable<LoanBatch[]>([]);
export const loanItems = writable<LoanItem[]>([]);
export const loanLoading = writable(false);
export const loanReady = writable(false);
export const loanError = writable('');

/** 借出中的批次（按借出日期倒序） */
export const activeBatches = derived(loanBatches, ($batches) =>
  $batches
    .filter((batch) => batch.status === 'active')
    .sort((a, b) => b.loanDate.localeCompare(a.loanDate) || b.createdAt - a.createdAt),
);

/** 已归还结清的批次（按借出日期倒序） */
export const returnedBatches = derived(loanBatches, ($batches) =>
  $batches
    .filter((batch) => batch.status === 'returned')
    .sort((a, b) => b.loanDate.localeCompare(a.loanDate) || b.createdAt - a.createdAt),
);

/** 待处理条目（归还时有缺损，待养护结论） */
export const pendingItems = derived(loanItems, ($items) =>
  $items
    .filter((item) => item.status === 'pending')
    .sort((a, b) => b.updatedAt - a.updatedAt),
);

/** 借出中的条目 */
export const lentItems = derived(loanItems, ($items) =>
  $items.filter((item) => item.status === 'lent'),
);

/** 当前被锁定（借出中）的印石 id 集合 */
export const lockedStoneIds = derived(stones, ($stones) => {
  const set = new Set<string>();
  $stones.forEach((stone) => {
    if (stone.lentOut) set.add(stone.id);
  });
  return set;
});

export async function loadLoans(): Promise<void> {
  loanLoading.set(true);
  try {
    const [batches, items] = await Promise.all([db.loanBatches.toArray(), db.loanItems.toArray()]);
    batches.sort((a, b) => b.updatedAt - a.updatedAt);
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    loanBatches.set(batches);
    loanItems.set(items);
    loanError.set('');
    loanReady.set(true);
  } catch (err) {
    loanError.set(err instanceof Error ? err.message : '借展批次读取失败');
    loanReady.set(true);
  } finally {
    loanLoading.set(false);
  }
}

export function batchById(id: string): LoanBatch | undefined {
  return get(loanBatches).find((batch) => batch.id === id);
}

export function itemsOfBatch(batchId: string): LoanItem[] {
  return get(loanItems)
    .filter((item) => item.batchId === batchId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function pendingItemsOfBatch(batchId: string): LoanItem[] {
  return itemsOfBatch(batchId).filter((item) => item.status === 'pending');
}

/* ------------------------------ 锁定守卫 ------------------------------ */

export function isStoneLentOut(stoneId: string): boolean {
  return get(stones).some((stone) => stone.id === stoneId && stone.lentOut);
}

/** 借出期间禁止改写印稿 / 工序 / 钤印；抛出的错误由页面提示 */
export function assertStoneWritable(stoneId: string): void {
  if (isStoneLentOut(stoneId)) {
    throw new Error('该印石处于借展借出期间，印稿、工序与钤印记录已锁定；请先在「借展点交」页归还后再修改。');
  }
}

/* ------------------------------ 点交出库 ------------------------------ */

/** 生成批次编号 LOAN-YYYYMMDD-NNN（当日序号） */
async function nextBatchNo(now: number): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `LOAN-${day}-`;
  const existing = await db.loanBatches.toArray();
  const seq = existing.filter((batch) => batch.batchNo.startsWith(prefix)).length + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/**
 * 点交出库：从已收录未借出的印石中选一批，登记借展方、归还日与印谱快照，整批进入借出。
 * 事务内重读印石做 compare-and-swap：任一印石已被借出 / 未收录 / 不存在即整批拒绝并回滚。
 */
export async function createLoanBatch(input: CreateLoanInput): Promise<LoanBatch> {
  const borrower = input.borrower.trim();
  const eventName = input.eventName.trim();
  const expectedReturnDate = input.expectedReturnDate;
  const note = input.note.trim();
  const stoneIds = [...new Set(input.stoneIds)];
  if (!borrower) throw new Error('请填写借展方');
  if (!expectedReturnDate) throw new Error('请填写归还日期');
  if (stoneIds.length === 0) throw new Error('请选择要点交的印石');

  const batchId = createId('loan');
  const now = Date.now();
  const loanDate = new Date(now).toISOString().slice(0, 10);

  await db.transaction(
    'rw',
    [db.stones, db.designs, db.impressions, db.catalogs, db.loanBatches, db.loanItems],
    async () => {
      // 1. 重读目标印石（compare-and-swap：多标签并发点交时，后提交者读到先提交者的借出标记）
      const targetStones = await db.stones.where('id').anyOf(stoneIds).toArray();
      const found = new Map(targetStones.map((stone) => [stone.id, stone]));
      const missing = stoneIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new LoanConflictError(`以下印石已不存在，本次点交已拒绝：${missing.join('、')}`, missing);
      }

      // 2. 借出校验：任一方已被借出则整批拒绝，不覆盖先完成的借出
      const alreadyLent = targetStones.filter((stone) => stone.lentOut);
      if (alreadyLent.length > 0) {
        throw new LoanConflictError(
          `以下印石已被其他借展批次借出，本次点交已拒绝：${alreadyLent.map((stone) => stone.name).join('、')}`,
          alreadyLent.map((stone) => stone.id),
        );
      }

      // 3. 收录校验：必须是「已收录」进印谱的印石
      const catalogs = await db.catalogs.where('stoneId').anyOf(stoneIds).toArray();
      const includedByStone = new Map<string, Catalog>();
      catalogs.forEach((catalog) => {
        if (catalog.included === 'included' && !includedByStone.has(catalog.stoneId)) {
          includedByStone.set(catalog.stoneId, catalog);
        }
      });
      const notIncluded = targetStones.filter((stone) => !includedByStone.has(stone.id));
      if (notIncluded.length > 0) {
        throw new LoanConflictError(
          `以下印石尚未收录进印谱，不能点交：${notIncluded.map((stone) => stone.name).join('、')}`,
          notIncluded.map((stone) => stone.id),
        );
      }

      // 4. 组装点交印谱快照（冻结印文 / 释文 / 评级等信息）
      const designs = await db.designs.where('stoneId').anyOf(stoneIds).toArray();
      const designIds = designs.map((design) => design.id);
      const impressions =
        designIds.length > 0 ? await db.impressions.where('designId').anyOf(designIds).toArray() : [];
      const snapshot: LoanSnapshotItem[] = targetStones.map((stone) => {
        const catalog = includedByStone.get(stone.id)!;
        const adopted = pickAdoptedDesign(designs, stone.id);
        const best = adopted
          ? impressions
              .filter((impression) => impression.designId === adopted.id)
              .sort((a, b) => GRADE_WEIGHT[b.grade as Grade] - GRADE_WEIGHT[a.grade as Grade])[0]
          : undefined;
        return {
          stoneId: stone.id,
          stoneName: stone.name,
          stoneType: stone.stoneType,
          sizeMm: stone.sizeMm,
          catalogOrderNo: catalog.orderNo,
          sealText: adopted?.sealText ?? '',
          annotation: adopted?.annotation ?? '',
          style: adopted?.style ?? '',
          bestGrade: best?.grade ?? '',
        };
      });

      // 5. 写入批次与条目
      const batchNo = await nextBatchNo(now);
      const batch: LoanBatch = {
        id: batchId,
        batchNo,
        borrower,
        eventName,
        loanDate,
        expectedReturnDate,
        status: 'active',
        sealSnapshot: JSON.stringify(snapshot),
        itemCount: stoneIds.length,
        note,
        createdAt: now,
        updatedAt: now,
      };
      const items: LoanItem[] = targetStones.map((stone) => {
        const catalog = includedByStone.get(stone.id)!;
        const adopted = pickAdoptedDesign(designs, stone.id);
        return {
          id: createId('litem'),
          batchId,
          stoneId: stone.id,
          catalogId: catalog.id,
          designId: adopted?.id ?? '',
          sealText: adopted?.sealText ?? stone.name,
          status: 'lent',
          damage: '',
          maintenance: '',
          returnedAt: '',
          createdAt: now,
          updatedAt: now,
        };
      });
      await db.loanBatches.put(batch);
      await db.loanItems.bulkPut(items);

      // 6. 回写印石借出标记（同一事务，失败整体回滚）
      await db.stones.bulkPut(
        targetStones.map((stone) => ({ ...stone, lentOut: true, currentLoanId: batchId, updatedAt: now })),
      );
    },
  );

  await loadLoans();
  await loadStones();
  const created = await db.loanBatches.get(batchId);
  if (!created) throw new Error('点交写入失败，请从原清单重试');
  return created;
}

function pickAdoptedDesign(designs: Design[], stoneId: string): Design | undefined {
  return designs
    .filter((design) => design.stoneId === stoneId)
    .sort((a, b) => Number(b.adopted) - Number(a.adopted) || b.updatedAt - a.updatedAt)[0];
}

/* ------------------------------ 归还 / 待处理 ------------------------------ */

/** 归还后若该印石已无借出中的条目，则解除借出标记 */
async function releaseStoneIfReturned(stoneId: string, now: number): Promise<void> {
  const stillLent = (await db.loanItems.where('stoneId').equals(stoneId).toArray()).some(
    (item) => item.status === 'lent',
  );
  if (!stillLent) {
    await db.stones.update(stoneId, { lentOut: false, currentLoanId: null, updatedAt: now });
  }
}

/** 整批归还：逐方核对并记录缺损与养护结论；有缺损的列入「待处理」。单事务，失败整批恢复。 */
export async function returnLoanItems(batchId: string, returns: ReturnItemInput[]): Promise<void> {
  await db.transaction('rw', [db.loanBatches, db.loanItems, db.stones], async () => {
    const now = Date.now();
    const batch = await db.loanBatches.get(batchId);
    if (!batch) throw new Error('借展批次不存在');
    const itemIds = returns.map((item) => item.itemId);
    const items = await db.loanItems.where('id').anyOf(itemIds).toArray();
    const byId = new Map(items.map((item) => [item.id, item]));
    const updated: LoanItem[] = [];
    const affectedStoneIds = new Set<string>();

    for (const input of returns) {
      const item = byId.get(input.itemId);
      if (!item) throw new Error('借展条目不存在');
      if (item.batchId !== batchId) throw new Error('条目与批次不匹配');
      if (item.status !== 'lent') throw new Error(`「${item.sealText}」已归还，不能重复归还`);
      affectedStoneIds.add(item.stoneId);
      const status: LoanItemStatus = input.hasDamage ? 'pending' : 'returned';
      updated.push({
        ...item,
        status,
        damage: input.hasDamage ? input.damage.trim() : '',
        maintenance: input.maintenance.trim(),
        returnedAt: new Date(now).toISOString().slice(0, 10),
        updatedAt: now,
      });
    }

    await db.loanItems.bulkPut(updated);
    for (const stoneId of affectedStoneIds) {
      await releaseStoneIfReturned(stoneId, now);
    }
    await reconcileBatchStatus(batchId, now);
  });

  await loadLoans();
  await loadStones();
}

/** 待处理条目结清：补录养护结论并置为已归还 */
export async function resolveLoanItem(itemId: string, maintenance: string): Promise<void> {
  await db.transaction('rw', [db.loanBatches, db.loanItems, db.stones], async () => {
    const now = Date.now();
    const item = await db.loanItems.get(itemId);
    if (!item) throw new Error('借展条目不存在');
    if (item.status !== 'pending') throw new Error('该条目不在待处理状态');
    await db.loanItems.update(itemId, {
      status: 'returned',
      maintenance: maintenance.trim() || item.maintenance,
      updatedAt: now,
    });
    await releaseStoneIfReturned(item.stoneId, now);
    await reconcileBatchStatus(item.batchId, now);
  });

  await loadLoans();
  await loadStones();
}

/** 批次全部条目都已归还（含待处理结清）后，批次置为已归还 */
async function reconcileBatchStatus(batchId: string, now: number): Promise<void> {
  const items = await db.loanItems.where('batchId').equals(batchId).toArray();
  const allDone = items.length > 0 && items.every((item) => item.status === 'returned');
  if (allDone) {
    await db.loanBatches.update(batchId, { status: 'returned', updatedAt: now });
  }
}

/* ------------------------------ 内部辅助 ------------------------------ */
