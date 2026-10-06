/**
 * 借展批次 store（Svelte writable / derived）
 * 维护借展批次列表与在借印石映射；点交 / 归还动作走 $lib/utils/loan 的事务服务。
 */
import { derived, get, writable } from 'svelte/store';
import { db } from '$lib/utils/db';
import { activeStoneMap } from '$lib/utils/loan';
import {
  LOAN_ITEM_STATE_LABEL,
  batchHasActiveItems,
  type LoanBatch,
  type LoanItemState,
} from '$lib/types/loan';

export const loanBatches = writable<LoanBatch[]>([]);
export const loanLoading = writable(false);
export const loanReady = writable(false);
export const loanError = writable('');

/** 批次按批次号倒序（新批次在前） */
export const sortedLoanBatches = derived(loanBatches, ($batches) =>
  [...$batches].sort((a, b) => b.batchNo - a.batchNo),
);

/** 在借 / 待处理印石 id → 批次 id（旧档案缺明细状态字段时按在借兼容） */
export const activeLoans = derived(loanBatches, ($batches) => activeStoneMap($batches));

/** 全部处于借出锁定状态的印石 id（含缺损待处理 / 灭失） */
export const lockedStoneIds = derived(activeLoans, ($map) => new Set($map.keys()));

export const loanTotals = derived(loanBatches, ($batches) => {
  const active = $batches.filter((batch) => batchHasActiveItems(batch));
  const loaned = $batches.filter((batch) => batch.status === 'loaned').length;
  const partial = $batches.filter((batch) => batch.status === 'partial').length;
  const returned = $batches.filter((batch) => batch.status === 'returned').length;
  const drafts = $batches.filter((batch) => batch.status === 'draft').length;
  let itemLoaned = 0;
  let itemReturned = 0;
  let itemAbnormal = 0;
  let itemLost = 0;
  $batches.forEach((batch) => {
    batch.items.forEach((item) => {
      if (item.state === 'loaned') itemLoaned += 1;
      else if (item.state === 'returned') itemReturned += 1;
      else if (item.state === 'abnormal') itemAbnormal += 1;
      else if (item.state === 'lost') itemLost += 1;
    });
  });
  return { batches: $batches.length, active: active.length, loaned, partial, returned, drafts, itemLoaned, itemReturned, itemAbnormal, itemLost };
});

export async function loadLoanBatches(): Promise<void> {
  loanLoading.set(true);
  try {
    const rows = await db.loans.toArray();
    rows.sort((a, b) => b.batchNo - a.batchNo);
    loanBatches.set(rows);
    loanError.set('');
    loanReady.set(true);
  } catch (err) {
    loanError.set(err instanceof Error ? err.message : '借展批次读取失败');
    loanReady.set(true);
  } finally {
    loanLoading.set(false);
  }
}

export function loanBatchById(id: string): LoanBatch | undefined {
  return get(loanBatches).find((batch) => batch.id === id);
}

/** 某印石当前所在借展批次（未借出返回 undefined；旧档案缺字段按未借出） */
export function activeBatchOfStone(stoneId: string): LoanBatch | undefined {
  const map = get(activeLoans);
  const batchId = map.get(stoneId);
  return batchId ? get(loanBatches).find((batch) => batch.id === batchId) : undefined;
}

/** 借展明细的中文状态（供台账 / 印谱页复用） */
export function loanStateLabel(state: LoanItemState | string): string {
  return LOAN_ITEM_STATE_LABEL[state as LoanItemState] ?? '借出中';
}
