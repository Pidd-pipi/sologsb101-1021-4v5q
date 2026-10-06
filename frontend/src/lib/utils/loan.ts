/**
 * 借展点交领域服务
 *
 * 关键约束：
 * - 只能选择「印谱已收录且未借出」的印石出库；
 * - 点交在单个 IndexedDB 事务内完成：冲突复检 → 印谱快照 → 明细置借出 →
 *   印石/印稿/工序/钤印/印谱条目全部加锁 → 批次落库，任一写入失败整批回滚；
 * - 多标签 / 多批次并发提交时，先完成的批次占用印石，后提交的批次抛 LoanConflictError 被拒绝；
 * - 点交前先落 draft（待点交）留档，提交失败后可凭原清单原样重试；
 * - 归还逐方核对：完好解锁定为已核还；缺损 / 灭失列入待处理（保持锁定），养护处理后再核销。
 */
import { createId, db, notifyDataChange } from './db';
import type { Stone } from '$lib/types/stone';
import type { Design } from '$lib/types/design';
import type { Carve } from '$lib/types/carve';
import type { Impression } from '$lib/types/impression';
import type { Catalog } from '$lib/types/catalog';
import {
  createLoanItem,
  deriveBatchStatus,
  isItemLocked,
  LoanConflictError,
  type CatalogSnapshot,
  type LoanBatch,
  type LoanItem,
  type ReturnCondition,
} from '$lib/types/loan';

/** 点交登记表单 */
export interface CheckoutInput {
  borrower: string;
  dueDate: string;
  loanedAt: string;
  handler: string;
  note: string;
  stoneIds: string[];
}

/** 归还核对单方结果 */
export interface ReturnCheck {
  stoneId: string;
  condition: ReturnCondition;
  damageNote: string;
  careNote: string;
  returnedAt: string;
  checkedBy: string;
}

const ALL_TABLES = [db.stones, db.designs, db.carves, db.impressions, db.catalogs, db.loans] as const;

/** 已生效（占用印石）的批次：借出中 / 部分归还（draft 不占印石） */
function batchOccupiesStones(batch: LoanBatch): boolean {
  return batch.status === 'loaned' || batch.status === 'partial';
}

/** 汇总当前被在借 / 待处理明细占用的印石 id → 批次 */
export function activeStoneMap(batches: LoanBatch[]): Map<string, string> {
  const map = new Map<string, string>();
  batches.forEach((batch) => {
    if (!batchOccupiesStones(batch)) return;
    batch.items.forEach((item) => {
      if (isItemLocked(item)) map.set(item.stoneId, batch.id);
    });
  });
  return map;
}

/** 印石是否允许出库：印谱已收录、且未被在借批次占用 */
export function isStoneEligible(stoneId: string, catalogs: Catalog[], lockedIds: Set<string>): boolean {
  if (lockedIds.has(stoneId)) return false;
  return catalogs.some((catalog) => catalog.stoneId === stoneId && catalog.included === 'included');
}

/** 某印石已刻方数：采用稿且工序全部完成（与台账统计口径一致） */
function carvedCountOf(stoneId: string, designs: Design[], carves: Carve[]): number {
  return designs.filter((design) => {
    if (design.stoneId !== stoneId || !design.adopted) return false;
    const steps = carves.filter((carve) => carve.designId === design.id);
    return steps.length > 0 && steps.every((step) => step.state === 'done');
  }).length;
}

function buildSnapshot(
  stones: Stone[],
  designs: Design[],
  carves: Carve[],
  impressions: Impression[],
  catalogs: Catalog[],
): CatalogSnapshot {
  return {
    stones: stones.map((row) => ({ ...row })),
    designs: designs.map((row) => ({ ...row })),
    carves: carves.map((row) => ({ ...row })),
    impressions: impressions.map((row) => ({ ...row })),
    catalogs: catalogs.map((row) => ({ ...row })),
  };
}

/**
 * 保存点交草稿（待点交状态，不占用印石）。
 * 正常点交流程：先建草稿 → commitCheckout；提交失败后凭草稿「原清单重试」。
 */
export async function saveCheckoutDraft(input: CheckoutInput): Promise<LoanBatch> {
  const now = Date.now();
  const [stones, designs, carves, impressions, catalogs, batches] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
    db.loans.toArray(),
  ]);
  const items: LoanItem[] = input.stoneIds.map((stoneId) =>
    createLoanItem(stoneId, stones.find((stone) => stone.id === stoneId)?.state ?? 'idle', carvedCountOf(stoneId, designs, carves)),
  );
  const batchNo = batches.reduce((max, batch) => Math.max(max, batch.batchNo), 0) + 1;
  const batch: LoanBatch = {
    id: createId('loan'),
    batchNo,
    borrower: input.borrower.trim(),
    dueDate: input.dueDate,
    loanedAt: input.loanedAt,
    handler: input.handler.trim(),
    note: input.note.trim(),
    status: 'draft',
    items,
    snapshot: buildSnapshot(stones, designs, carves, impressions, catalogs),
    lastError: '',
    createdAt: now,
    updatedAt: now,
  };
  await db.loans.put(batch);
  notifyDataChange('draft-save');
  return batch;
}

/** 校验点交登记表单，返回错误文案（空串通过） */
export function validateCheckoutInput(input: CheckoutInput, catalogs: Catalog[], lockedIds: Set<string>): string {
  if (input.borrower.trim().length === 0) return '请填写借展方';
  if (input.loanedAt.length === 0) return '请选择点交日期';
  if (input.dueDate.length === 0) return '请选择约定归还日';
  if (input.dueDate < input.loanedAt) return '约定归还日不能早于点交日期';
  if (input.handler.trim().length === 0) return '请填写点交经办人';
  if (input.stoneIds.length === 0) return '请至少勾选一方已收录且未借出的印章';
  const missing = input.stoneIds.filter((stoneId) => !isStoneEligible(stoneId, catalogs, lockedIds));
  if (missing.length > 0) return `清单中有 ${missing.length} 方已借出或未收录进印谱，请刷新后重选`;
  return '';
}

/**
 * 提交点交（整批出库）。
 * 事务内重新读取最新数据复检冲突，保证多标签 / 多批次并发下后提交者被拒绝。
 * 失败时把错误文案写回草稿（draft.lastError）并原样抛出，草稿清单保留可重试。
 */
export async function commitCheckout(batchId: string): Promise<LoanBatch> {
  const draft = await db.loans.get(batchId);
  if (!draft) throw new Error('点交批次不存在或已被删除');
  if (draft.status !== 'draft') throw new Error('该批次已完成点交，不能重复提交');

  try {
    const committed = await db.transaction('rw', ALL_TABLES, async (tx) => {
      const [stones, designs, carves, impressions, catalogs, batches] = await Promise.all([
        tx.stones.toArray(),
        tx.designs.toArray(),
        tx.carves.toArray(),
        tx.impressions.toArray(),
        tx.catalogs.toArray(),
        tx.loans.toArray(),
      ]);

      // 冲突复检：其它已生效批次占用的印石不能重复出库
      const occupied = new Map<string, string>();
      batches.forEach((batch) => {
        if (batch.id === draft.id || !batchOccupiesStones(batch)) return;
        batch.items.forEach((item) => {
          if (isItemLocked(item)) occupied.set(item.stoneId, batch.borrower || batch.id);
        });
      });
      const wanted = new Set(draft.items.map((item) => item.stoneId));
      const clash = [...wanted].filter((stoneId) => occupied.has(stoneId));
      if (clash.length > 0) {
        const names = clash
          .map((stoneId) => stones.find((stone) => stone.id === stoneId)?.name ?? stoneId)
          .join('、');
        throw new LoanConflictError(`点交被拒绝：${names} 已由先完成的批次借出，不能重复出库`);
      }

      // 入库资格复检：印石仍存在且印谱已收录
      for (const stoneId of wanted) {
        const stone = stones.find((row) => row.id === stoneId);
        if (!stone) throw new Error(`点交失败：印石 ${stoneId} 已不存在，整批恢复`);
        if (stone.loanLocked) throw new LoanConflictError('点交被拒绝：清单中含已借出印石，请刷新后重试');
        const listed = catalogs.some(
          (catalog) => catalog.stoneId === stoneId && catalog.included === 'included',
        );
        if (!listed) throw new Error(`点交失败：${stone.name} 尚未收录进印谱，整批恢复`);
      }

      const now = Date.now();
      const items: LoanItem[] = draft.items.map((item) => {
        const stone = stones.find((row) => row.id === item.stoneId);
        return {
          ...item,
          stoneState: stone?.state ?? item.stoneState,
          carvedCount: carvedCountOf(item.stoneId, designs, carves),
          state: 'loaned',
          returnCondition: '',
          damageNote: '',
          careNote: '',
          returnedAt: '',
          checkedBy: '',
        };
      });

      // 印石 → 印稿 → 工序 / 钤印 / 印谱条目整批加锁
      const stoneIds = new Set(items.map((item) => item.stoneId));
      const designIds = new Set(designs.filter((design) => stoneIds.has(design.stoneId)).map((design) => design.id));

      await tx.stones.bulkPut(
        stones
          .filter((stone) => stoneIds.has(stone.id))
          .map((stone) => ({ ...stone, loanLocked: true, loanBatchId: draft.id, updatedAt: now })),
      );
      await tx.designs.bulkPut(
        designs
          .filter((design) => designIds.has(design.id))
          .map((design) => ({ ...design, loanLocked: true, updatedAt: now })),
      );
      await tx.carves.bulkPut(
        carves
          .filter((carve) => designIds.has(carve.designId))
          .map((carve) => ({ ...carve, loanLocked: true, updatedAt: now })),
      );
      await tx.impressions.bulkPut(
        impressions
          .filter((impression) => designIds.has(impression.designId))
          .map((impression) => ({ ...impression, loanLocked: true, updatedAt: now })),
      );
      await tx.catalogs.bulkPut(
        catalogs
          .filter((catalog) => stoneIds.has(catalog.stoneId))
          .map((catalog) => ({ ...catalog, loanLocked: true, updatedAt: now })),
      );

      const finished: LoanBatch = {
        ...draft,
        status: 'loaned',
        items,
        snapshot: buildSnapshot(stones, designs, carves, impressions, catalogs),
        lastError: '',
        updatedAt: now,
      };
      await tx.loans.put(finished);
      return finished;
    });
    notifyDataChange('checkout');
    return committed;
  } catch (error) {
    // 整批已随事务回滚；把失败原因挂到草稿上，供「原清单重试」展示
    const message = error instanceof Error ? error.message : '点交写入失败，整批已恢复';
    await db.loans.update(batchId, { lastError: message, updatedAt: Date.now() } as never);
    notifyDataChange('checkout-failed');
    throw error instanceof LoanConflictError ? error : new Error(message);
  }
}

/** 一次性点交：建草稿 + 提交（失败保留草稿，可重试） */
export async function checkoutBatch(input: CheckoutInput): Promise<LoanBatch> {
  const draft = await saveCheckoutDraft(input);
  return commitCheckout(draft.id);
}

/** 删除待点交草稿（失败留档 / 放弃清单时用；已生效批次不能删） */
export async function removeDraft(batchId: string): Promise<void> {
  const batch = await db.loans.get(batchId);
  if (!batch) return;
  if (batch.status !== 'draft') throw new Error('已生效的借展批次不能删除');
  await db.loans.delete(batchId);
  notifyDataChange('draft-delete');
}

/**
 * 归还核还：逐方提交结论，单事务整批写入。
 * - 完好：明细置「已核还」并解除该石全部锁定；
 * - 缺损：明细置「缺损待处理」，保持锁定；
 * - 灭失：明细置「灭失」，保持锁定；
 * 任一方写入失败整批回滚（已核对的结果也不会半落库）。
 */
export async function returnChecks(batchId: string, checks: ReturnCheck[]): Promise<LoanBatch> {
  return db.transaction('rw', ALL_TABLES, async (tx) => {
    const batch = await tx.loans.get(batchId);
    if (!batch) throw new Error('借展批次不存在');
    if (batch.status !== 'loaned' && batch.status !== 'partial') {
      throw new Error('当前批次状态不允许归还核对');
    }
    const [stones, designs, carves, impressions, catalogs] = await Promise.all([
      tx.stones.toArray(),
      tx.designs.toArray(),
      tx.carves.toArray(),
      tx.impressions.toArray(),
      tx.catalogs.toArray(),
    ]);
    const checkMap = new Map(checks.map((check) => [check.stoneId, check]));
    const now = Date.now();

    // 本次核还完好、可解除锁定的印石
    const intactStoneIds = new Set(
      checks.filter((check) => check.condition === 'intact').map((check) => check.stoneId),
    );

    const items: LoanItem[] = batch.items.map((item) => {
      const check = checkMap.get(item.stoneId);
      if (!check || !isItemLocked(item) || item.state === 'lost' || item.state === 'abnormal') return item;
      return {
        ...item,
        state: check.condition === 'intact' ? 'returned' : check.condition === 'lost' ? 'lost' : 'abnormal',
        returnCondition: check.condition,
        damageNote: check.damageNote.trim(),
        careNote: check.careNote.trim(),
        returnedAt: check.condition === 'intact' ? check.returnedAt : item.returnedAt,
        checkedBy: check.checkedBy.trim(),
      };
    });

    // 缺损 / 灭失的印石本次仍锁定；只有完好方解锁
    await tx.stones.bulkPut(
      stones
        .filter((stone) => intactStoneIds.has(stone.id))
        .map((stone) => ({ ...stone, loanLocked: false, loanBatchId: '', updatedAt: now })),
    );
    const intactDesignIds = new Set(
      designs.filter((design) => intactStoneIds.has(design.stoneId)).map((design) => design.id),
    );
    await tx.designs.bulkPut(
      designs
        .filter((design) => intactDesignIds.has(design.id))
        .map((design) => ({ ...design, loanLocked: false, updatedAt: now })),
    );
    await tx.carves.bulkPut(
      carves
        .filter((carve) => intactDesignIds.has(carve.designId))
        .map((carve) => ({ ...carve, loanLocked: false, updatedAt: now })),
    );
    await tx.impressions.bulkPut(
      impressions
        .filter((impression) => intactDesignIds.has(impression.designId))
        .map((impression) => ({ ...impression, loanLocked: false, updatedAt: now })),
    );
    await tx.catalogs.bulkPut(
      catalogs
        .filter((catalog) => intactStoneIds.has(catalog.stoneId))
        .map((catalog) => ({ ...catalog, loanLocked: false, updatedAt: now })),
    );

    const finished: LoanBatch = {
      ...batch,
      items,
      status: deriveBatchStatus(items),
      updatedAt: now,
    };
    await tx.loans.put(finished);
    return finished;
  }).then((finished) => {
    notifyDataChange('return');
    return finished;
  });
}

/**
 * 异常处理核销：缺损 / 灭失待处理明细在养护结论落实后核销为已核还，并解除锁定。
 */
export async function resolveAbnormalItem(
  batchId: string,
  stoneId: string,
  careNote: string,
  checkedBy: string,
): Promise<LoanBatch> {
  return db.transaction('rw', ALL_TABLES, async (tx) => {
    const batch = await tx.loans.get(batchId);
    if (!batch) throw new Error('借展批次不存在');
    const [stones, designs, carves, impressions, catalogs] = await Promise.all([
      tx.stones.toArray(),
      tx.designs.toArray(),
      tx.carves.toArray(),
      tx.impressions.toArray(),
      tx.catalogs.toArray(),
    ]);
    const now = Date.now();
    const items: LoanItem[] = batch.items.map((item) =>
      item.stoneId === stoneId && (item.state === 'abnormal' || item.state === 'lost')
        ? {
            ...item,
            state: 'returned',
            careNote: careNote.trim() || item.careNote,
            checkedBy: checkedBy.trim() || item.checkedBy,
          }
        : item,
    );

    const unlockIds = new Set([stoneId]);
    await tx.stones.bulkPut(
      stones
        .filter((stone) => unlockIds.has(stone.id))
        .map((stone) => ({ ...stone, loanLocked: false, loanBatchId: '', updatedAt: now })),
    );
    const designIds = new Set(designs.filter((design) => unlockIds.has(design.stoneId)).map((design) => design.id));
    await tx.designs.bulkPut(
      designs.filter((design) => designIds.has(design.id)).map((design) => ({ ...design, loanLocked: false, updatedAt: now })),
    );
    await tx.carves.bulkPut(
      carves.filter((carve) => designIds.has(carve.designId)).map((carve) => ({ ...carve, loanLocked: false, updatedAt: now })),
    );
    await tx.impressions.bulkPut(
      impressions
        .filter((impression) => designIds.has(impression.designId))
        .map((impression) => ({ ...impression, loanLocked: false, updatedAt: now })),
    );
    await tx.catalogs.bulkPut(
      catalogs
        .filter((catalog) => unlockIds.has(catalog.stoneId))
        .map((catalog) => ({ ...catalog, loanLocked: false, updatedAt: now })),
    );

    const finished: LoanBatch = { ...batch, items, status: deriveBatchStatus(items), updatedAt: now };
    await tx.loans.put(finished);
    return finished;
  }).then((finished) => {
    notifyDataChange('resolve-abnormal');
    return finished;
  });
}
