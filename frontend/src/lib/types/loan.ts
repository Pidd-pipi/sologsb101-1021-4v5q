/**
 * 借展点交（Loan）数据模型
 * 已收录印石的出库点交：登记借展方、归还日与印谱快照，整批进入借出；
 * 归还时逐方核对并记录缺损与养护结论，异常先列入待处理。
 */

/** 借展批次状态：借出中 / 已归还（整批结清） */
export type LoanBatchStatus = 'active' | 'returned';

/** 借展条目状态：借出中 / 已归还 / 待处理（归还时有缺损，待养护结论） */
export type LoanItemStatus = 'lent' | 'returned' | 'pending';

export interface LoanBatch {
  id: string;
  /** 批次编号，如 LOAN-20261006-001 */
  batchNo: string;
  /** 借展方 */
  borrower: string;
  /** 展览名称 */
  eventName: string;
  /** 借出日期 yyyy-MM-dd */
  loanDate: string;
  /** 应还日期 yyyy-MM-dd */
  expectedReturnDate: string;
  /** 批次状态 */
  status: LoanBatchStatus;
  /** 点交时冻结的印谱快照（JSON 字符串，元素为 LoanSnapshotItem） */
  sealSnapshot: string;
  /** 点交方数 */
  itemCount: number;
  /** 备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoanItem {
  id: string;
  /** 所属借展批次 id */
  batchId: string;
  /** 借出印石 id */
  stoneId: string;
  /** 对应印谱条目 id */
  catalogId: string;
  /** 对应印稿 id（采用稿） */
  designId: string;
  /** 印文快照（点交时的印文） */
  sealText: string;
  /** 条目状态 */
  status: LoanItemStatus;
  /** 缺损情况（归还时登记） */
  damage: string;
  /** 养护结论（归还时登记或待处理结清时补录） */
  maintenance: string;
  /** 实际归还日期 yyyy-MM-dd，未归还为空串 */
  returnedAt: string;
  createdAt: number;
  updatedAt: number;
}

/** 点交时冻结的印谱快照条目（一方印石一条） */
export interface LoanSnapshotItem {
  stoneId: string;
  stoneName: string;
  stoneType: string;
  sizeMm: string;
  catalogOrderNo: number;
  sealText: string;
  annotation: string;
  style: string;
  bestGrade: string;
}

export type LoanBatchDraft = Omit<LoanBatch, 'id' | 'batchNo' | 'status' | 'sealSnapshot' | 'itemCount' | 'createdAt' | 'updatedAt'>;

export const LOAN_BATCH_STATUS_LABEL: Record<LoanBatchStatus, string> = {
  active: '借出中',
  returned: '已归还',
};

export const LOAN_BATCH_STATUS_COLOR: Record<LoanBatchStatus, string> = {
  active: '#9c2b1f',
  returned: '#3f6b57',
};

export const LOAN_ITEM_STATUS_LABEL: Record<LoanItemStatus, string> = {
  lent: '借出中',
  returned: '已归还',
  pending: '待处理',
};

export const LOAN_ITEM_STATUS_COLOR: Record<LoanItemStatus, string> = {
  lent: '#9c2b1f',
  returned: '#3f6b57',
  pending: '#b98a3c',
};

/** 待处理结清时的养护结论模板选项 */
export const MAINTENANCE_TEMPLATE_OPTIONS: readonly string[] = [
  '核对印面与边款无损，锦盒收纳',
  '印面清洁后薄涂保养油，锦盒收纳',
  '磕碰处打蜡养护，更换锦盒',
  '印泥残留清理，阴干后收纳',
];

export function parseSnapshot(raw: string): LoanSnapshotItem[] {
  try {
    const parsed = JSON.parse(raw) as LoanSnapshotItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
