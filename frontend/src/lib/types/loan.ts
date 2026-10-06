/**
 * 借展批次（LoanBatch）数据模型
 * 印社借展点交：从已收录、未借出的印章中选一批出库，登记借展方、归还日与印谱快照；
 * 点交后整批进入借出，相关印稿、工序与钤印记录锁住。
 * 归还时逐方核对缺损与养护结论，异常列入待处理；任一写入失败整批回滚。
 */

/** 批次状态：待点交（草稿失败留档）/ 借出中 / 部分归还 / 已归还 */
export type LoanBatchStatus = 'draft' | 'loaned' | 'partial' | 'returned';

/** 单方借出明细状态：待点交 / 借出中 / 已核还 / 缺损异常（待处理）/ 灭失 */
export type LoanItemState = 'pending' | 'loaned' | 'returned' | 'abnormal' | 'lost';

/** 归还核对结论：完好 / 缺损 / 灭失 */
export type ReturnCondition = 'intact' | 'damaged' | 'lost';

/** 点交时的印谱快照：六张表的全量只读副本（借展批次同步留档） */
export interface CatalogSnapshot {
  stones: unknown[];
  designs: unknown[];
  carves: unknown[];
  impressions: unknown[];
  catalogs: unknown[];
}

/** 借展批次中的单方明细 */
export interface LoanItem {
  /** 印石 id */
  stoneId: string;
  /** 出库时状态（在刻 / 已刻 / 闲置） */
  stoneState: string;
  /** 点交时该石已刻方数 */
  carvedCount: number;
  /** 单方状态 */
  state: LoanItemState;
  /** 归还核对结论 */
  returnCondition: ReturnCondition | '';
  /** 缺损描述（边角磕碰 / 印面磨损等） */
  damageNote: string;
  /** 养护结论（上油 / 配盒 / 休养等） */
  careNote: string;
  /** 实际归还日期 yyyy-MM-dd */
  returnedAt: string;
  /** 核对人 */
  checkedBy: string;
}

export interface LoanBatch {
  /** 主键 */
  id: string;
  /** 批次号，从 1 起连续（loan_0001…） */
  batchNo: number;
  /** 借展方（单位 / 经办人） */
  borrower: string;
  /** 约定归还日 yyyy-MM-dd */
  dueDate: string;
  /** 点交日期 yyyy-MM-dd */
  loanedAt: string;
  /** 点交经办人 */
  handler: string;
  /** 批次备注（展名、场馆等） */
  note: string;
  /** 批次状态 */
  status: LoanBatchStatus;
  /** 整批点交清单（一方一项） */
  items: LoanItem[];
  /** 点交时的印谱快照 */
  snapshot: CatalogSnapshot;
  /** 点交失败留档的错误文案（draft 状态用于原清单重试） */
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export type LoanBatchDraft = Omit<LoanBatch, 'id' | 'createdAt' | 'updatedAt'>;

/** 创建点交明细时的初始结构 */
export function createLoanItem(stoneId: string, stoneState: string, carvedCount: number): LoanItem {
  return {
    stoneId,
    stoneState,
    carvedCount,
    state: 'pending',
    returnCondition: '',
    damageNote: '',
    careNote: '',
    returnedAt: '',
    checkedBy: '',
  };
}

export const LOAN_BATCH_STATUS_LABEL: Record<LoanBatchStatus, string> = {
  draft: '待点交',
  loaned: '借出中',
  partial: '部分归还',
  returned: '已归还',
};

export const LOAN_BATCH_STATUS_COLOR: Record<LoanBatchStatus, string> = {
  draft: '#8b8f90',
  loaned: '#9c2b1f',
  partial: '#b98a3c',
  returned: '#3f6b57',
};

export const LOAN_ITEM_STATE_LABEL: Record<LoanItemState, string> = {
  pending: '待点交',
  loaned: '借出中',
  returned: '已核还',
  abnormal: '缺损待处理',
  lost: '灭失',
};

export const LOAN_ITEM_STATE_COLOR: Record<LoanItemState, string> = {
  pending: '#8b8f90',
  loaned: '#9c2b1f',
  returned: '#3f6b57',
  abnormal: '#b98a3c',
  lost: '#23282a',
};

export const RETURN_CONDITION_LABEL: Record<ReturnCondition, string> = {
  intact: '完好',
  damaged: '缺损',
  lost: '灭失',
};

export const RETURN_CONDITION_COLOR: Record<ReturnCondition, string> = {
  intact: '#3f6b57',
  damaged: '#b98a3c',
  lost: '#23282a',
};

export const RETURN_CONDITION_OPTIONS: ReadonlyArray<{ value: ReturnCondition; label: string }> = [
  { value: 'intact', label: '完好' },
  { value: 'damaged', label: '缺损' },
  { value: 'lost', label: '灭失' },
];

/** 养护常用结论（点选用） */
export const CARE_NOTE_OPTIONS: readonly string[] = ['无需养护，归位存放', '表面上油养护', '更换锦盒', '休养避晒一月', '印面清理除尘', '补拓留档'];

/** 旧档案缺字段时的兼容状态：明细仍视为在借锁定 */
export function isActiveItemState(state: string | undefined): boolean {
  return state === 'loaned' || state === 'abnormal' || state === 'lost' || state === undefined;
}

/** 该明细是否仍处于锁定（借出未完好归还，或异常待处理） */
export function isItemLocked(item: LoanItem): boolean {
  return item.state === 'loaned' || item.state === 'abnormal' || item.state === 'lost';
}

/** 批次是否仍有在借 / 待处理明细 */
export function batchHasActiveItems(batch: LoanBatch): boolean {
  return batch.items.some((item) => isItemLocked(item));
}

/** 由明细集合推导批次状态 */
export function deriveBatchStatus(items: LoanItem[]): LoanBatchStatus {
  if (items.length > 0 && items.every((item) => item.state === 'returned')) return 'returned';
  if (items.some((item) => item.state === 'returned')) return 'partial';
  // 无已核还方：即使全部缺损 / 灭失，也仍有借出中或待处理明细，保持借出中（逾期由归还日提示）
  return 'loaned';
}

/** 点交冲突错误：多标签 / 多批次并发提交时，后提交的一方被拒绝 */
export class LoanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanConflictError';
  }
}
