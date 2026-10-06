<script lang="ts">
  /**
   * /loans 借展点交
   * 从已收录、未借出的印章选批出库，登记借展方、归还日与印谱快照；
   * 点交后整批进入借出并锁住印稿 / 工序 / 钤印记录；多标签并发时后提交批次被拒绝；
   * 归还逐方核对缺损与养护结论，异常列入待处理；写入失败整批回滚并可凭原清单重试。
   * 台账、印谱与借展批次同步显示（各页订阅同源 IndexedDB）。
   */
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { stones, loadStones } from '$lib/stores/stoneStore';
  import { loadDesigns } from '$lib/stores/designStore';
  import { loadCarves } from '$lib/stores/carveStore';
  import { loadImpressions } from '$lib/stores/impressionStore';
  import {
    loadLoanBatches,
    lockedStoneIds,
    loanTotals,
    sortedLoanBatches,
  } from '$lib/stores/loanStore';
  import type { Catalog } from '$lib/types/catalog';
  import {
    CARE_NOTE_OPTIONS,
    LOAN_BATCH_STATUS_COLOR,
    LOAN_BATCH_STATUS_LABEL,
    LOAN_ITEM_STATE_COLOR,
    LOAN_ITEM_STATE_LABEL,
    RETURN_CONDITION_LABEL,
    RETURN_CONDITION_OPTIONS,
    type CatalogSnapshot,
    type LoanBatch,
    type LoanItem,
    type ReturnCondition,
  } from '$lib/types/loan';
  import { STONE_STATE_LABEL, STONE_TYPE_LABEL, KNOB_STYLE_LABEL, type StoneType, type KnobStyle, type StoneState } from '$lib/types/stone';
  import {
    checkoutBatch,
    commitCheckout,
    removeDraft,
    resolveAbnormalItem,
    returnChecks,
    validateCheckoutInput,
    type ReturnCheck,
  } from '$lib/utils/loan';
  import { LoanConflictError } from '$lib/types/loan';

  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let toast = $state('');
  let toastTone = $state<'ok' | 'err'>('ok');
  let checkoutOpen = $state(false);
  let returnBatch = $state<LoanBatch | null>(null);
  let resolveTarget = $state<{ batch: LoanBatch; item: LoanItem } | null>(null);
  let snapshotBatch = $state<LoanBatch | null>(null);
  let pendingDeleteDraft = $state<LoanBatch | null>(null);
  let busy = $state(false);

  // 点交表单
  const today = new Date().toISOString().slice(0, 10);
  let fBorrower = $state('');
  let fDueDate = $state('');
  let fLoanedAt = $state(today);
  let fHandler = $state('');
  let fNote = $state('');
  let fStoneIds = $state<string[]>([]);

  // 归还表单（按 stoneId 索引）
  let rCondition = $state<Record<string, ReturnCondition>>({});
  let rDamage = $state<Record<string, string>>({});
  let rCare = $state<Record<string, string>>({});
  let rCheckedBy = $state('');

  // 异常核销表单
  let resolveCare = $state('');
  let resolveBy = $state('');

  function showToast(text: string, tone: 'ok' | 'err' = 'ok'): void {
    toast = text;
    toastTone = tone;
    setTimeout(() => (toast = ''), 3200);
  }

  const eligibleStones = $derived(
    $stones.filter((stone) =>
      $catalogRows.some((catalog) => catalog.stoneId === stone.id && catalog.included === 'included'),
    ),
  );
  const selectableStones = $derived(eligibleStones.filter((stone) => !$lockedStoneIds.has(stone.id)));
  const lockedCount = $derived(eligibleStones.length - selectableStones.length);

  function stoneName(stoneId: string): string {
    return $stones.find((stone) => stone.id === stoneId)?.name ?? '（印石已删除）';
  }

  function batchOverdue(batch: LoanBatch): boolean {
    return batch.dueDate < today && batch.items.some((item) => item.state === 'loaned');
  }

  function toggleCheckoutStone(id: string): void {
    fStoneIds = fStoneIds.includes(id) ? fStoneIds.filter((item) => item !== id) : [...fStoneIds, id];
  }

  function openCheckout(): void {
    if (selectableStones.length === 0) {
      showToast('没有可出库的印章：请先在印谱中收录，或等待在借印章归还', 'err');
      return;
    }
    fBorrower = '';
    fDueDate = '';
    fLoanedAt = today;
    fHandler = '';
    fNote = '';
    fStoneIds = selectableStones.length === 1 ? [selectableStones[0]!.id] : [];
    checkoutOpen = true;
  }

  async function reloadAll(): Promise<void> {
    await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), loadLoanBatches(), catalogTable.refresh()]);
  }

  async function submitCheckout(): Promise<void> {
    const input = {
      borrower: fBorrower,
      dueDate: fDueDate,
      loanedAt: fLoanedAt,
      handler: fHandler,
      note: fNote,
      stoneIds: fStoneIds,
    };
    const invalid = validateCheckoutInput(input, $catalogRows, $lockedStoneIds);
    if (invalid) {
      showToast(invalid, 'err');
      return;
    }
    busy = true;
    try {
      const batch = await checkoutBatch(input);
      checkoutOpen = false;
      await reloadAll();
      showToast(`批次 loan_${String(batch.batchNo).padStart(4, '0')} 点交完成，${batch.items.length} 方已出库并锁定`);
    } catch (error) {
      checkoutOpen = false;
      await loadLoanBatches();
      if (error instanceof LoanConflictError) showToast(error.message, 'err');
      else showToast(error instanceof Error ? error.message : '点交失败，整批已恢复，可从待点交草稿原清单重试', 'err');
    } finally {
      busy = false;
    }
  }

  async function retryDraft(batch: LoanBatch): Promise<void> {
    busy = true;
    try {
      const finished = await commitCheckout(batch.id);
      await reloadAll();
      showToast(`批次 loan_${String(finished.batchNo).padStart(4, '0')} 重试点交成功，${finished.items.length} 方已出库`);
    } catch (error) {
      await loadLoanBatches();
      showToast(error instanceof Error ? error.message : '重试失败，整批已恢复', 'err');
    } finally {
      busy = false;
    }
  }

  async function confirmDeleteDraft(): Promise<void> {
    if (!pendingDeleteDraft) return;
    try {
      await removeDraft(pendingDeleteDraft.id);
      await loadLoanBatches();
      showToast('待点交草稿已删除');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'err');
    } finally {
      pendingDeleteDraft = null;
    }
  }

  const returnableItems = $derived(
    returnBatch ? returnBatch.items.filter((item) => item.state === 'loaned' || item.state === 'abnormal' || item.state === 'lost') : [],
  );

  function openReturn(batch: LoanBatch): void {
    returnBatch = batch;
    rCondition = {};
    rDamage = {};
    rCare = {};
    rCheckedBy = batch.handler;
  }

  async function submitReturn(): Promise<void> {
    if (!returnBatch) return;
    const checks: ReturnCheck[] = returnableItems
      .map((item) => {
        const condition = rCondition[item.stoneId];
        if (!condition) return null;
        return {
          stoneId: item.stoneId,
          condition,
          damageNote: rDamage[item.stoneId] ?? '',
          careNote: rCare[item.stoneId] ?? '',
          returnedAt: today,
          checkedBy: rCheckedBy.trim(),
        };
      })
      .filter((item): item is ReturnCheck => item !== null);
    if (checks.length === 0) {
      showToast('请至少为一方印章选择核对结论', 'err');
      return;
    }
    if (!rCheckedBy.trim()) {
      showToast('请填写归还核对人', 'err');
      return;
    }
    for (const check of checks) {
      if (check.condition === 'damaged' && !check.damageNote.trim()) {
        showToast(`「${stoneName(check.stoneId)}」标记缺损，请填写缺损描述`, 'err');
        return;
      }
      if (!check.careNote.trim()) {
        showToast(`「${stoneName(check.stoneId)}」请填写养护结论`, 'err');
        return;
      }
    }
    busy = true;
    try {
      await returnChecks(returnBatch.id, checks);
      returnBatch = null;
      await reloadAll();
      const damaged = checks.filter((check) => check.condition !== 'intact').length;
      showToast(
        damaged > 0
          ? `已核还 ${checks.length - damaged} 方；${damaged} 方异常，已列入待处理并保持锁定`
          : `已核还 ${checks.length} 方，相关印稿 / 工序 / 钤印记录已解锁`,
      );
    } catch (error) {
      showToast(error instanceof Error ? `归还写入失败，整批恢复：${error.message}` : '归还写入失败，整批恢复', 'err');
    } finally {
      busy = false;
    }
  }

  function openResolve(batch: LoanBatch, item: LoanItem): void {
    resolveTarget = { batch, item };
    resolveCare = item.careNote || CARE_NOTE_OPTIONS[1];
    resolveBy = item.checkedBy || batch.handler;
  }

  async function submitResolve(): Promise<void> {
    if (!resolveTarget) return;
    if (!resolveCare.trim()) {
      showToast('请填写养护处理结论', 'err');
      return;
    }
    busy = true;
    try {
      await resolveAbnormalItem(resolveTarget.batch.id, resolveTarget.item.stoneId, resolveCare, resolveBy);
      resolveTarget = null;
      await reloadAll();
      showToast('异常已处理核销，该方解锁并标记为已核还');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '核销失败，已恢复', 'err');
    } finally {
      busy = false;
    }
  }

  function snapshotCounts(snapshot: CatalogSnapshot): string {
    return `印石 ${snapshot.stones.length} · 印稿 ${snapshot.designs.length} · 工序 ${snapshot.carves.length} · 钤印 ${snapshot.impressions.length} · 谱录 ${snapshot.catalogs.length}`;
  }

  function snapshotStoneRow(snapshot: CatalogSnapshot, stoneId: string): Record<string, unknown> | undefined {
    return snapshot.stones.find((row) => (row as { id?: string }).id === stoneId) as Record<string, unknown> | undefined;
  }

  function snapStoneType(value: unknown): string {
    return STONE_TYPE_LABEL[value as StoneType] ?? String(value ?? '—');
  }

  function snapKnob(value: unknown): string {
    return KNOB_STYLE_LABEL[value as KnobStyle] ?? String(value ?? '—');
  }

  function snapState(value: unknown): string {
    return STONE_STATE_LABEL[value as StoneState] ?? String(value ?? '—');
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">借展点交与归还核还</h2>
      <p class="mt-1 text-sm text-ink-soft">
        从已收录、未借出的印章选批出库；点交锁定印稿 / 工序 / 钤印，归还逐方核对缺损与养护，异常列入待处理。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="gb-btn" onclick={() => void reloadAll()}>刷新</button>
      <button class="gb-btn-primary" onclick={openCheckout}>新建点交批次</button>
    </div>
  </div>

  {#if toast}
    <div
      class="rounded-xl border px-4 py-2 text-sm {toastTone === 'ok'
        ? 'border-jade/40 bg-jade/10 text-jade'
        : 'border-seal/40 bg-seal/10 text-seal'}"
    >
      {toast}
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="借展批次" value={$loanTotals.batches} suffix="批" tone="seal" />
    <StatBadge label="借出中批次" value={$loanTotals.loaned + $loanTotals.partial} suffix="批" tone="amber" />
    <StatBadge label="在借印章" value={$loanTotals.itemLoaned} suffix="方" tone="seal" />
    <StatBadge label="异常待处理" value={$loanTotals.itemAbnormal + $loanTotals.itemLost} suffix="方" tone="ink" />
    <StatBadge label="已核还" value={$loanTotals.itemReturned} suffix="方" tone="jade" />
    <StatBadge label="待点交草稿" value={$loanTotals.drafts} suffix="批" />
  </div>

  {#if $sortedLoanBatches.length === 0}
    <EmptyPanel
      title="还没有借展批次"
      description="选择一方或多方印谱已收录的印章出库，登记借展方、约定归还日并留存印谱快照；任一写入失败都会整批回滚，可凭原清单重试。"
      actionText="新建点交批次"
      onAction={openCheckout}
    />
  {:else}
    <div class="space-y-4">
      {#each $sortedLoanBatches as batch (batch.id)}
        {@const statusColor = LOAN_BATCH_STATUS_COLOR[batch.status]}
        <article class="gb-panel">
          <header class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-lg font-bold tracking-wide text-ink">批次 loan_{String(batch.batchNo).padStart(4, '0')}</span>
              <span class="gb-tag" style="color:{statusColor};border-color:{statusColor}66">
                {LOAN_BATCH_STATUS_LABEL[batch.status]}
              </span>
              {#if batch.status !== 'draft' && batchOverdue(batch)}
                <span class="gb-tag" style="color:#9c2b1f;border-color:#9c2b1f66">已逾归还日</span>
              {/if}
              {#if batch.status === 'draft' && batch.lastError}
                <span class="gb-tag" style="color:#9c2b1f;border-color:#9c2b1f66">上次点交失败</span>
              {/if}
            </div>
            <div class="flex flex-wrap gap-2">
              <button class="gb-btn" onclick={() => (snapshotBatch = batch)}>查看印谱快照</button>
              {#if batch.status === 'draft'}
                <button class="gb-btn-primary" disabled={busy} onclick={() => void retryDraft(batch)}>
                  原清单重试点交
                </button>
                <button class="gb-btn-danger" onclick={() => (pendingDeleteDraft = batch)}>删除草稿</button>
              {:else if batch.status === 'loaned' || batch.status === 'partial'}
                <button
                  class="gb-btn-primary"
                  disabled={busy || batch.items.every((item) => item.state !== 'loaned')}
                  onclick={() => openReturn(batch)}
                >
                  归还核对
                </button>
              {/if}
            </div>
          </header>

          {#if batch.status === 'draft' && batch.lastError}
            <div class="mt-2 rounded-lg border border-seal/40 bg-seal/10 px-3 py-2 text-xs text-seal">
              失败原因：{batch.lastError}。清单与快照原样保留，冲突解除后可直接重试。
            </div>
          {/if}

          <dl class="mt-3 grid gap-x-6 gap-y-1 text-sm text-ink-soft sm:grid-cols-2 lg:grid-cols-3">
            <div>借展方：<strong class="text-ink">{batch.borrower || '—'}</strong></div>
            <div>点交日期：{batch.loanedAt || '—'}</div>
            <div>约定归还日：{batch.dueDate || '—'}</div>
            <div>点交经办人：{batch.handler || '—'}</div>
            <div>清单：{batch.items.length} 方</div>
            <div>快照：{snapshotCounts(batch.snapshot)}</div>
            {#if batch.note}<div class="sm:col-span-2 lg:col-span-3">备注：{batch.note}</div>{/if}
          </dl>

          <div class="mt-3 overflow-x-auto">
            <table class="gb-table">
              <thead>
                <tr>
                  <th class="w-10">序</th>
                  <th>印章</th>
                  <th class="w-28">出库时状态</th>
                  <th class="w-28">已刻方数</th>
                  <th class="w-32">点交状态</th>
                  <th class="w-24">归还结论</th>
                  <th>缺损 / 养护</th>
                  <th class="w-40">操作</th>
                </tr>
              </thead>
              <tbody>
                {#each batch.items as item, index (item.stoneId)}
                  {@const itemColor = LOAN_ITEM_STATE_COLOR[item.state]}
                  <tr>
                    <td class="tabular-nums">{index + 1}</td>
                    <td>{stoneName(item.stoneId)}</td>
                    <td>{STONE_STATE_LABEL[item.stoneState as keyof typeof STONE_STATE_LABEL] ?? item.stoneState}</td>
                    <td class="tabular-nums">{item.carvedCount}</td>
                    <td>
                      <span class="gb-tag" style="color:{itemColor};border-color:{itemColor}66">
                        {LOAN_ITEM_STATE_LABEL[item.state]}
                      </span>
                    </td>
                    <td>
                      {item.returnCondition ? RETURN_CONDITION_LABEL[item.returnCondition] : '—'}
                      {#if item.returnedAt}<div class="text-xs text-ink-soft">{item.returnedAt}</div>{/if}
                    </td>
                    <td class="text-xs text-ink-soft">
                      {#if item.damageNote}<div>缺损：{item.damageNote}</div>{/if}
                      {#if item.careNote}<div>养护：{item.careNote}</div>{/if}
                      {#if item.checkedBy}<div>核对：{item.checkedBy}</div>{/if}
                    </td>
                    <td>
                      {#if item.state === 'abnormal' || item.state === 'lost'}
                        <button class="gb-btn px-2 py-1" onclick={() => openResolve(batch, item)}>养护处理核销</button>
                      {:else}
                        <span class="text-xs text-ink-soft">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <p class="text-xs text-ink-soft">
    并发保护：点交在单个事务内复检印石占用，多标签或多批次同时提交时，先完成的借出生效，后提交批次被拒绝并原样保留清单；归还同样整批事务，任一写入失败即回滚。旧档案缺少借展字段时一律按「未借出」兼容显示。
  </p>
</div>

<!-- 新建点交批次 -->
{#if checkoutOpen}
  <div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 px-4 py-8">
    <div class="w-full max-w-3xl rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">新建借展点交批次</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="gb-label">借展方（单位 / 经办人）</span>
          <input class="gb-input" bind:value={fBorrower} placeholder="如：浙江省博物馆 · 借展部" />
        </label>
        <label class="block">
          <span class="gb-label">点交经办人</span>
          <input class="gb-input" bind:value={fHandler} placeholder="如：顾墨" />
        </label>
        <label class="block">
          <span class="gb-label">点交日期</span>
          <input class="gb-input" type="date" bind:value={fLoanedAt} />
        </label>
        <label class="block">
          <span class="gb-label">约定归还日</span>
          <input class="gb-input" type="date" bind:value={fDueDate} />
        </label>
        <label class="block sm:col-span-2">
          <span class="gb-label">备注（展名 / 场馆等）</span>
          <input class="gb-input" bind:value={fNote} placeholder="如：「金石同寿」篆刻特展" />
        </label>
      </div>

      <div class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <span class="gb-label !mb-0">出库清单（仅印谱已收录且未借出，已选 {fStoneIds.length} 方）</span>
          <span class="text-xs text-ink-soft">{lockedCount} 方在借中不可选</span>
        </div>
        <div class="max-h-[280px] space-y-1 overflow-y-auto rounded-lg border border-line p-2">
          {#each selectableStones as stone (stone.id)}
            <label
              class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-black/5"
            >
              <input type="checkbox" checked={fStoneIds.includes(stone.id)} onchange={() => toggleCheckoutStone(stone.id)} />
              <span class="font-medium text-ink">{stone.name}</span>
              <span class="text-xs text-ink-soft">
                {$catalogRows.filter((catalog) => catalog.stoneId === stone.id && catalog.included === 'included').length} 条已收录
              </span>
            </label>
          {/each}
        </div>
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (checkoutOpen = false)}>取消</button>
        <button class="gb-btn-primary" disabled={busy} onclick={() => void submitCheckout()}>
          {busy ? '点交提交中…' : '确认点交出库'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- 归还核对 -->
{#if returnBatch}
  <div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 px-4 py-8">
    <div class="w-full max-w-3xl rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-1 text-lg text-ink">
        归还核还 · loan_{String(returnBatch.batchNo).padStart(4, '0')}（{returnBatch.borrower}）
      </h3>
      <p class="mb-3 text-xs text-ink-soft">逐方核对；完好方解锁归位，缺损 / 灭失列入待处理并保持锁定。本批一次提交，失败整批回滚。</p>

      <div class="max-h-[46vh] space-y-3 overflow-y-auto">
        {#each returnableItems as item (item.stoneId)}
          {#if item.state !== 'loaned'}
            <section class="rounded-lg border border-amber/50 bg-amber/10 p-3 text-sm">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-semibold text-ink">{stoneName(item.stoneId)}</span>
                <span class="gb-tag" style="color:#b98a3c;border-color:#b98a3c66">
                  {LOAN_ITEM_STATE_LABEL[item.state]} · 不在本次勾选
                </span>
              </div>
              <p class="mt-1 text-xs text-ink-soft">
                {item.damageNote ? `缺损：${item.damageNote}；` : ''}请先在列表中「养护处理核销」，落实养护后该方解锁归位。
              </p>
            </section>
          {:else}
            <section class="rounded-lg border border-line p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-semibold text-ink">{stoneName(item.stoneId)}</span>
                <div class="flex gap-1">
                  {#each RETURN_CONDITION_OPTIONS as option (option.value)}
                    <button
                      class="rounded-full border px-3 py-1 text-xs {rCondition[item.stoneId] === option.value
                        ? 'border-seal bg-seal/10 text-seal'
                        : 'border-line text-ink-soft'}"
                      onclick={() => (rCondition = { ...rCondition, [item.stoneId]: option.value })}
                    >
                      {option.label}
                    </button>
                  {/each}
                </div>
              </div>
              {#if rCondition[item.stoneId] === 'damaged'}
                <label class="mt-2 block">
                  <span class="gb-label">缺损描述（必填）</span>
                  <input
                    class="gb-input"
                    value={rDamage[item.stoneId] ?? ''}
                    placeholder="如：印台边角磕碰 2mm 崩口"
                    oninput={(event) =>
                      (rDamage = { ...rDamage, [item.stoneId]: (event.currentTarget as HTMLInputElement).value })}
                  />
                </label>
              {/if}
              <label class="mt-2 block">
                <span class="gb-label">养护结论（必填）</span>
                <input
                  class="gb-input"
                  list="care-options"
                  value={rCare[item.stoneId] ?? ''}
                  placeholder="如：表面上油养护 / 休养避晒一月"
                  oninput={(event) =>
                    (rCare = { ...rCare, [item.stoneId]: (event.currentTarget as HTMLInputElement).value })}
                />
              </label>
            </section>
          {/if}
        {/each}
      </div>

      <datalist id="care-options">
        {#each CARE_NOTE_OPTIONS as option (option)}<option value={option}></option>{/each}
      </datalist>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="gb-label">归还日期</span>
          <input class="gb-input" type="date" value={today} readonly />
        </label>
        <label class="block">
          <span class="gb-label">核对人</span>
          <input class="gb-input" bind:value={rCheckedBy} />
        </label>
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (returnBatch = null)}>取消</button>
        <button class="gb-btn-primary" disabled={busy} onclick={() => void submitReturn()}>
          {busy ? '提交中…' : '整批提交核对'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- 异常养护核销 -->
{#if resolveTarget}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">异常处理核销</h3>
      <p class="mt-2 text-sm text-ink-soft">
        「{stoneName(resolveTarget.item.stoneId)}」当前为
        {LOAN_ITEM_STATE_LABEL[resolveTarget.item.state]}
        {#if resolveTarget.item.damageNote}（{resolveTarget.item.damageNote}）{/if}
        ，落实养护后核销为已核还并解除锁定。
      </p>
      <div class="mt-3 space-y-3">
        <label class="block">
          <span class="gb-label">养护处理结论</span>
          <input class="gb-input" list="resolve-care-options" bind:value={resolveCare} />
          <datalist id="resolve-care-options">
            {#each CARE_NOTE_OPTIONS as option (option)}<option value={option}></option>{/each}
          </datalist>
        </label>
        <label class="block">
          <span class="gb-label">处理 / 核对人</span>
          <input class="gb-input" bind:value={resolveBy} />
        </label>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (resolveTarget = null)}>取消</button>
        <button class="gb-btn-primary" disabled={busy} onclick={() => void submitResolve()}>核销并解锁</button>
      </div>
    </div>
  </div>
{/if}

<!-- 印谱快照 -->
{#if snapshotBatch}
  <div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 px-4 py-8">
    <div class="w-full max-w-3xl rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-1 text-lg text-ink">
        印谱快照 · loan_{String(snapshotBatch.batchNo).padStart(4, '0')}
      </h3>
      <p class="mb-3 text-xs text-ink-soft">
        点交时刻留档（{snapshotCounts(snapshotBatch.snapshot)}），归还时以此为底本逐方核对，不随后续改动变化。
      </p>
      <div class="max-h-[60vh] overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th class="w-10">序</th>
              <th>印章</th>
              <th>石种 / 钮式</th>
              <th>状态</th>
              <th>尺寸</th>
              <th>购入日</th>
            </tr>
          </thead>
          <tbody>
            {#each snapshotBatch.items as item, index (item.stoneId)}
              {@const row = snapshotStoneRow(snapshotBatch.snapshot, item.stoneId)}
              <tr>
                <td class="tabular-nums">{index + 1}</td>
                <td>{(row?.name as string) ?? stoneName(item.stoneId)}</td>
                <td>{snapStoneType(row?.stoneType)} · {snapKnob(row?.knobStyle)}</td>
                <td>{snapState(row?.state)}</td>
                <td>{String(row?.sizeMm ?? '—')}</td>
                <td>{String(row?.purchaseDate ?? '—')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="mt-5 flex justify-end">
        <button class="gb-btn-primary" onclick={() => (snapshotBatch = null)}>关闭</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDeleteDraft}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除待点交草稿</h3>
      <p class="mt-2 text-sm text-ink-soft">
        草稿尚未出库、不占用印石；删除后原清单需要重新勾选。确认删除批次
        loan_{String(pendingDeleteDraft.batchNo).padStart(4, '0')}？
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDeleteDraft = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDeleteDraft()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
