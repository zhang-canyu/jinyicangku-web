<template>
	<view class="fix-top-window">
		<view class="uni-header">
			<uni-stat-breadcrumb class="uni-stat-breadcrumb-on-phone" />
			<view class="uni-group">
				<input class="uni-search" type="text" v-model="keyword" @confirm="onSearch"
					placeholder="搜索单号 / 客户 / 品名 / 颜色" />
				<button class="uni-button hide-on-phone" type="default" size="mini" @click="onSearch">搜索</button>
			</view>
			<view class="filter-chips-row">
				<view class="chip-group">
					<text class="chip-group-label">类型</text>
					<view v-for="(t,i) in typeOptions" :key="'t'+i" class="chip"
						:class="{ active: typeIndex===i }" @tap="pickType(i)">{{ t }}</view>
				</view>
				<view class="chip-group">
					<text class="chip-group-label">状态</text>
					<view v-for="(s,i) in statusOptions" :key="'s'+i" class="chip"
						:class="{ active: statusIndex===i }" @tap="pickStatus(i)">{{ s }}</view>
				</view>
				<!-- 日期 + 操作员 包在同一行（操作员始终在日期右侧） -->
				<view class="date-operator-row">
					<view class="chip-group">
						<text class="chip-group-label">日期</text>
						<view v-for="(d,i) in dateQuickOptions" :key="'d'+i" class="chip"
							:class="{ active: datePresetIndex===i }" @tap="pickDatePreset(i)">{{ d }}</view>
					</view>
					<view class="chip-group operator-group">
						<text class="chip-group-label">操作员</text>
						<uni-data-select v-model="operatorIndex" :localdata="operatorSelectOptions"
							placeholder="全部" :clear="false" :style="{ width: '160rpx' }"
							@change="onOperatorChange" />
					</view>
				</view>
			</view>
		</view>

		<view class="uni-container">
			<uni-table ref="table" :loading="loading" :emptyText="emptyText" border stripe>
				<uni-tr>
					<uni-th align="left">单号</uni-th>
					<uni-th align="left">客户</uni-th>
					<uni-th align="center">类型</uni-th>
					<uni-th align="center">状态</uni-th>
					<uni-th align="right">条数 / 米数</uni-th>
					<uni-th align="left">操作员</uni-th>
					<uni-th align="center">日期</uni-th>
					<uni-th align="center">操作</uni-th>
				</uni-tr>
				<uni-tr v-for="o in list" :key="o.id">
					<uni-td align="left">
						<view class="order-no">{{ o.no || '—' }}</view>
					</uni-td>
					<uni-td align="left">
						<view class="customer" @click="openDetail(o)">{{ o.customer || '—' }}</view>
					</uni-td>
					<uni-td align="center">
						<view class="type-tag" :class="'type-tag-' + (o.source || '')">
							<text>{{ sourceText(o) }}</text>
						</view>
					</uni-td>
					<uni-td align="center">
						<view class="status-dot" :title="o.status || '—'">
							<uni-icons v-if="statusIcon(o.status)" :type="statusIcon(o.status)" size="20"
								:color="iconColorFor(statusTag(o.status))" />
						</view>
					</uni-td>
					<uni-td align="right">{{ amountText(o) }}</uni-td>
					<uni-td align="left">{{ o.operator || o.createdName || '—' }}</uni-td>
					<uni-td align="center">
						<view class="date-time">
							<text>{{ o.date || '—' }}</text>
							<text v-if="o.time" class="time-text">{{ o.time }}</text>
						</view>
					</uni-td>
					<uni-td align="center">
						<button class="uni-button" size="mini" type="primary" @click="openDetail(o)">详情</button>
					</uni-td>
				</uni-tr>
			</uni-table>

			<view class="uni-pagination-box">
				<uni-pagination show-iconn show-page-size :page-size="pagination.size"
					v-model="pagination.current" :total="pagination.count" @change="onPageChanged"
					@pageSizeSize="onPageSizeChange" />
			</view>
		</view>

		<!-- ── 订单详情抽屉（码单式：紧凑、表格化、只保留必要信息） ──
		 * 去掉：hero 客户名大字、eyebrow、卡片化、大留白、section 大写小灰字
		 * 保留：label-value 行、细码横/纵缩进、合计横条
		 * 已发货状态：不显示图标（绿圆 + title 提示） -->
		<uni-popup ref="detailPopup" type="right" :mask-click="true">
			<view class="detail-popup">
				<view class="detail-header">
					<text class="detail-no">{{ currentOrder ? currentOrder.no : '—' }}</text>
					<view class="detail-close" @tap="closeDetail">×</view>
				</view>

				<scroll-view scroll-y class="detail-scroll">
					<view v-if="detailLoading" class="detail-loading"><text>加载中…</text></view>
					<view v-else-if="currentOrder" class="detail-body">

						<!-- 基础信息：label-value 行（紧贴顶部的部分不放 section 标题） -->
						<view class="kv-section first">
							<view class="kv-row">
								<text class="kv-k">客户</text>
								<text class="kv-v">{{ currentOrder.customer || '—' }}</text>
							</view>
							<view class="kv-row">
								<text class="kv-k">类型</text>
								<view class="kv-v">
									<view class="type-tag" :class="'type-tag-' + (currentOrder.source || '')">
										<text>{{ sourceText(currentOrder) }}</text>
									</view>
								</view>
							</view>
							<view class="kv-row">
								<text class="kv-k">状态</text>
								<view class="kv-v kv-v-status">
									<view class="status-dot-sm" :title="currentOrder.status">
										<uni-icons v-if="statusIcon(currentOrder.status)" :type="statusIcon(currentOrder.status)" size="16"
											:color="iconColorFor(statusTag(currentOrder.status))" />
									</view>
									<text class="status-text">{{ currentOrder.status || '—' }}</text>
								</view>
							</view>
							<view class="kv-row">
								<text class="kv-k">操作员</text>
								<text class="kv-v">{{ currentOrder.operator || currentOrder.createdName || '—' }}</text>
							</view>
							<view class="kv-row">
								<text class="kv-k">日期</text>
								<text class="kv-v mono">
									<text>{{ currentOrder.date || '—' }}</text>
									<text v-if="currentOrder.time" class="time-sm"> {{ currentOrder.time }}</text>
								</text>
							</view>
							<view v-if="currentOrder.remark" class="kv-row kv-row-stack">
								<text class="kv-k">备注</text>
								<text class="kv-v">{{ currentOrder.remark }}</text>
							</view>
						</view>

						<!-- 物流信息 -->
						<view v-if="hasExpress(currentOrder)" class="kv-section">
							<view class="section-divider">物流</view>
							<view v-if="currentOrder.expressNo" class="kv-row">
								<text class="kv-k">运单号</text>
								<text class="kv-v mono">{{ currentOrder.expressNo }}</text>
							</view>
							<view v-if="currentOrder.receiver" class="kv-row">
								<text class="kv-k">收件人</text>
								<text class="kv-v">
									{{ currentOrder.receiver }}
									<text v-if="currentOrder.receiverPhone" class="mono phone">{{ currentOrder.receiverPhone }}</text>
								</text>
							</view>
							<view v-if="currentOrder.address" class="kv-row">
								<text class="kv-k">地址</text>
								<text class="kv-v">{{ currentOrder.address }}</text>
							</view>
							<view v-if="currentOrder.expressImage" class="kv-row kv-row-thumb">
								<text class="kv-k">面单</text>
								<view class="thumb-wrap" @tap="previewImage(currentOrder.expressImage)">
									<image class="detail-express-thumb" :src="currentOrder.expressImage" mode="aspectFill" />
									<text class="thumb-hint">点击放大</text>
								</view>
							</view>
							</view>

						<!-- 出货明细：码单行（不卡片化，节省空间） -->
						<view v-if="currentItems.length" class="kv-section">
							<view class="section-divider">出货明细</view>
							<view class="items-list">
								<view v-for="(it, idx) in currentItems" :key="idx" class="item-line">
									<!-- 头部：品名+颜色（左） / 数量 chip+金额（右） -->
									<view class="item-line-head">
										<view class="item-line-summary">
											<text class="item-name-text">{{ it.name || '—' }}</text>
											<text v-if="it.color" class="pill pill-color">{{ it.color }}</text>
										</view>
										<view class="item-line-right">
											<text v-if="rollsOf(it).length" class="pill pill-qty">
												{{ it.count || 0 }}条 · {{ it.total_meters || 0 }}米
											</text>
											<text v-else-if="it.demandMeters || it.demandCount" class="pill pill-qty pill-qty-pending">
												需 {{ it.demandMeters || 0 }}米 / {{ it.demandCount || 0 }}条
											</text>
											<text v-if="it.amount !== undefined && it.amount !== null" class="item-amount">¥ {{ Number(it.amount).toFixed(2) }}</text>
										</view>
									</view>

									<!-- 库位行（独立小字，hover 整行变色） -->
									<view v-if="it.locations && it.locations.length" class="item-loc-line">
										<text class="item-loc-icon">📍</text>
										<text class="item-loc-text">{{ it.locations.join(' / ') }}</text>
									</view>

									<!-- 细码：横向 chip 列表（无序号、无单位；米数+短码组合） -->
									<view v-if="rollsOf(it).length" class="item-rolls">
										<view v-for="(r, ri) in rollsOf(it)" :key="ri" class="roll-chip">
											<text class="roll-chip-meters">{{ r }}</text>
											<text v-if="it.roll_ids && it.roll_ids[ri]" class="roll-chip-id">{{ shortId(it.roll_ids[ri]) }}</text>
										</view>
									</view>
								</view>
							</view>
						</view>

						<!-- 合计横条（码单底栏） -->
						<view v-if="(currentOrder.count || 0) + (currentOrder.total_meters || 0) > 0 || (currentOrder.total_amount || 0) > 0"
							class="kv-total">
							<text class="total-label">合计</text>
							<text class="total-figures mono">{{ currentOrder.count || 0 }}条 · {{ currentOrder.total_meters || 0 }}米</text>
							<text v-if="(currentOrder.total_amount || 0) > 0" class="total-amount">¥ {{ (currentOrder.total_amount || 0).toFixed(2) }}</text>
						</view>
					</view>

					<view v-else class="detail-loading"><text>暂无数据</text></view>
				</scroll-view>
			</view>
		</uni-popup>

		<!-- #ifndef H5 -->
		<fix-window />
		<!-- #endif -->
	</view>
</template>

<script>
/* ── 云对象：outbound-manage（小程序项目已部署，admin 复用同空间调用）
 *   - list/get 接口 admin 角色无 created_by 限制，可看到全部出库单
 *   - customUI: true 让错误以 {code,message,data} 形式返回，不抛异常，便于列表页静默处理 */
const outboundCo = uniCloud.importObject('outbound-manage', { customUI: true })

const PAGE_SIZE = 20

const TYPE_OPTIONS = ['全部', '大货', '打样', '直接出库']
const TYPE_KEYS = ['all', 'sales', 'sample', 'direct']
const STATUS_OPTIONS = ['全部', '待配货', '待确认', '待发货', '已发货', '已完成']
const STATUS_KEYS = ['all', '待配货', '待确认', '待发货', '已发货', '已完成']
/* 状态图标：状态文案 → uni-icons type
 * 已发货图标恢复：纸飞机（与「待发货」的 upload 形成「准备→发出」语义链）
 * 已取消：clear（圆圈叉，表示作废/终止）；statusTag 里未列出的状态一律灰色 */
const STATUS_ICON = {
	'待配货': 'spinner-cycle',     // 等待配货（循环）
	'待确认': 'help-filled',       // 待确认（问号）
	'待发货': 'upload-filled',     // 待发货（准备送出）
	'已发货': 'paperplane-filled', // 已发货（飞机已发出）
	'已完成': 'checkbox-filled',   // 已完成（勾选）
	'已取消': 'clear',             // 已取消（圆圈叉）
}
/* 日期快速预设：0 全部 / 1 今天 / 2 昨天 / 3 近7天（含今天）/ 4 近15天（含今天） */
const DATE_QUICK_OPTIONS = ['全部', '今天', '昨天', '近7天', '近15天']

export default {
	data() {
		return {
			keyword: '',
			typeIndex: 0,
			typeOptions: TYPE_OPTIONS,
			statusIndex: 0,
			statusOptions: STATUS_OPTIONS,
			datePresetIndex: 0,
			dateQuickOptions: DATE_QUICK_OPTIONS,
			operatorIndex: 0,
			operatorOptions: ['全部'],
			operatorSelectOptions: [{ text: '全部', value: 0 }],
			operatorsLoaded: false,
			list: [],
			loading: false,
			emptyText: '加载中…',
			hasLoaded: false,
			pagination: { current: 1, size: PAGE_SIZE, count: 0 },
			/* 详情弹窗状态 */
			detailLoading: false,
			currentOrder: null,
			currentItems: [],
		}
	},
	onShow() {
		// 首次进入加载列表；非首次保持当前页（返回页面不重置分页）
		if (!this.hasLoaded) this.load(true)
		// 操作员列表：成功拉取过就不再请求；失败时保持 operatorsLoaded=false，下次进入自动重试
		// —— 这样后端重新部署 `operators` 接口后，下次进入页面就能立即拿到新数据
		if (!this.operatorsLoaded) this.loadOperators()
	},
	methods: {
		typeKey() { return TYPE_KEYS[this.typeIndex] },
		statusKey() { return STATUS_KEYS[this.statusIndex] },
		operatorKey() { return this.operatorIndex === 0 ? 'all' : this.operatorOptions[this.operatorIndex] },

		buildParams() {
			const p = {
				type: this.typeKey(),
				status: this.statusKey(),
				operator: this.operatorKey(),
				page: this.pagination.current,
				pageSize: this.pagination.size,
			}
			const kw = this.keyword.trim()
			if (kw) p.keyword = kw
			const range = this.getPresetRange(this.datePresetIndex)
			if (range) { p.startDate = range.startDate; p.endDate = range.endDate }
			return p
		},

		async load(reset = true) {
			if (reset) this.pagination.current = 1
			this.loading = true
			if (!this.hasLoaded) this.emptyText = '加载中…'
			try {
				/* 云对象返回结构：{ code, message, data:{list,total,page,pageSize,hasMore} }
				 * customUI:true 让 code!=0 时不抛异常，按返回结构自己判 success/error */
				const res = await outboundCo.list(this.buildParams())
				if (res && res.code === 0) {
					const data = res.data || {}
					this.list = data.list || []
					this.pagination.count = data.total || 0
					this.emptyText = this.pagination.count === 0 ? '暂无相关订单' : ''
					this.hasLoaded = true
				} else {
					const msg = (res && res.message) || '加载失败'
					uni.showToast({ title: msg, icon: 'none' })
					this.emptyText = msg
				}
			} catch (e) {
				uni.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
				this.emptyText = (e && e.message) || '加载失败'
			} finally {
				this.loading = false
			}
		},

		onSearch() { this.load(true) },
		pickType(i) { this.typeIndex = i; this.load(true) },
		pickStatus(i) { this.statusIndex = i; this.load(true) },
		pickDatePreset(i) { this.datePresetIndex = i; this.load(true) },
		onOperatorChange(v) {
			// v 为选中的 value（即索引），与 v-model 双向绑定会自动更新 operatorIndex
			if (typeof v === 'number') this.load(true)
		},

		/* 拉取操作员列表（去重），用于下拉筛选
		 * 静默失败：拉不到时保持「全部」单选项，admin 端仍可正常用其他筛选
		 * 失败时 operatorsLoaded 不置 true，下次 onShow 会自动重试 */
		async loadOperators() {
			try {
				const res = await outboundCo.operators()
				if (res && res.code === 0) {
					const list = (res.data && res.data.list) || []
					this.operatorOptions = ['全部', ...list]
					// 同步为 uni-data-select 需要的 [{text, value}] 格式
					this.operatorSelectOptions = this.operatorOptions.map((name, i) => ({ text: name, value: i }))
					this.operatorsLoaded = true
				}
			} catch (e) {
				// 静默失败：保留「全部」单选项，operatorsLoaded 保持 false，下次重试
			}
		},

		/* 日期快速预设 → startDate/endDate（YYYY-MM-DD），供 buildParams 透传给云端
		 * 0:全部(无过滤) / 1:今天 / 2:昨天 / 3:近7天(含今天) / 4:近15天(含今天) */
		getPresetRange(idx) {
			if (!idx) return null
			const today = new Date(); today.setHours(0, 0, 0, 0)
			const fmt = (d) => {
				const p = (x) => String(x).padStart(2, '0')
				return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
			}
			const shift = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return d }
			if (idx === 1) { const s = fmt(today); return { startDate: s, endDate: s } }
			/* 昨天：单日区间，起止同为今天往前 1 天 */
			if (idx === 2) { const s = fmt(shift(-1)); return { startDate: s, endDate: s } }
			/* 近 N 天 = 含今天往前推 N-1 天 */
			if (idx === 3) return { startDate: fmt(shift(-6)), endDate: fmt(today) }
			if (idx === 4) return { startDate: fmt(shift(-14)), endDate: fmt(today) }
			return null
		},

		onPageChanged(e) {
			this.pagination.current = e.current || 1
			this.load(false)
		},
		onPageSizeChange(e) {
			this.pagination.size = e.pageSize || PAGE_SIZE
			this.load(true)
		},

		/* ── 详情弹窗 ──
		 * 替代原 goDetail 跳页：openDetail 调 outboundCo.get 取整单（含明细 items），
		 * 通过 ref 控制 uni-popup 打开/关闭；每次打开都重拉，保证数据最新 */
		async openDetail(o) {
			this.detailLoading = true
			this.currentOrder = null
			this.currentItems = []
			this.$refs.detailPopup.open()
			try {
				const res = await outboundCo.get({ id: o.id })
				if (res && res.code === 0) {
					const data = res.data || {}
					this.currentOrder = data
					this.currentItems = Array.isArray(data.items) ? data.items : []
				} else {
					uni.showToast({ title: (res && res.message) || '加载失败', icon: 'none' })
				}
			} catch (e) {
				uni.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
			} finally {
				this.detailLoading = false
			}
		},
		closeDetail() {
			this.$refs.detailPopup.close()
		},
		/* 快递面单缩略图点击 → 全屏预览 */
		previewImage(url) {
			uni.previewImage({ urls: [url], current: url })
		},

		/* ── 展示辅助 ── */
		sourceText(o) {
			return o.source === 'sample' ? '打样'
				: o.source === 'sales' ? '大货'
				: o.source === 'direct' ? '直接出库' : '—'
		},
		sourceTag(o) {
			return o.source === 'sample' ? 'warning'
				: o.source === 'sales' ? 'primary' : 'default'
		},
		statusTag(s) {
			if (s === '已发货' || s === '已完成') return 'success'
			if (s === '待发货') return 'primary'
			if (s === '待确认' || s === '待配货') return 'warning'
			return 'default'
		},
		/* ── 状态徽章辅助 ──
		 * 状态列改为纯图标：圆形彩色背景 + 居中白图标，hover 出现 title tooltip
		 *   statusIcon：状态 → uni-icons type（已发货故意返回空，不显示图标）
		 *   iconColorFor：tag type → 状态色（橙=待办/蓝=进行/绿=终态/灰=未知） */
		statusIcon(s) { return STATUS_ICON[s] || '' },
		iconColorFor(tagType) {
			return ({ primary: '#2979ff', success: '#19be6b', warning: '#ff9900' })[tagType] || '#909399'
		},
		/* 右侧条数/米数：与小程序列表保持一致口径
		 * - 打样单：未配货时显示需求米数，已配货显示实际米数
		 * - 大货/直接出库：已配货(c>0)显示配货条数；否则按 需求米数/需求条数/total_meters 顺序兜底 */
		amountText(o) {
			if (o.source === 'sample') {
				if (o.status !== '待配货' && o.total_meters) return o.total_meters + ' 米'
				if (o.demand_meters) return o.demand_meters + ' 米'
				if (o.demand_count) return o.demand_count + ' 条'
				return (o.total_meters || 0) + ' 米'
			}
			if (o.count > 0) return o.count + ' 条'
			if (o.demand_meters) return o.demand_meters + ' 米'
			if (o.demand_count) return o.demand_count + ' 条'
			return (o.total_meters || 0) + ' 米'
		},
		/* ── 弹窗内辅助 ── */
		hasExpress(o) {
			return !!(o && (o.expressNo || o.expressImage || o.receiver || o.receiverPhone || o.address))
		},
		/* 返回细码数组（rolls 中过滤掉 0/空值） */
		rollsOf(it) {
			return (it && Array.isArray(it.rolls)) ? it.rolls.filter((v) => v > 0) : []
		},
		/* 卷 id 截前 8 位作为简码（_id 很长，全显占空间；前 8 位已足够识别） */
		shortId(id) {
			if (!id) return ''
			const s = String(id)
			return s.length > 8 ? s.slice(0, 8) : s
		},
	},
}
</script>

<style lang="scss" scoped>
/* 筛选芯片行：类型 / 状态 / 日期+操作员 三组并排，自动换行 */
.filter-chips-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 10px 22px;
	margin-top: 2px;
}
/* 日期 + 操作员 子行：把这两组绑在一起，操作员始终在日期右侧（一起换行） */
.date-operator-row {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px 22px;
}
/* 操作员组：紧贴日期右侧（用 margin-left:auto 在窄屏时推到该行最右） */
.operator-group {
	margin-left: auto;
}
.chip-group {
	display: inline-flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px;
}
.chip-group-label {
	font-size: 13px;
	color: #606266;
	margin-right: 4px;
	white-space: nowrap;
	font-weight: 500;
}
.chip {
	display: inline-flex;
	align-items: center;
	height: 30px;
	padding: 0 14px;
	border: 1px solid #dcdfe6;
	border-radius: 15px;
	background: #fff;
	color: #303133;
	font-size: 14px;
	line-height: 1;
	cursor: pointer;
	user-select: none;
	white-space: nowrap;
	transition: all 0.15s ease;
	font-weight: 500;
}
.chip:hover { border-color: #c0c4cc; color: #303133; }
.chip.active {
	background: #2979ff;
	color: #fff;
	border-color: #2979ff;
}
.chip.active:hover { background: #1c66e0; border-color: #1c66e0; }

.order-no {
	font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
	font-size: 14px;
	color: #303133;
}
/* 类型列 tag：自定义（替代 uni-tag，色更深更清晰；「直接出库」不再像 placeholder） */
.type-tag {
	display: inline-block;
	padding: 4rpx 12rpx;
	font-size: 12px;
	font-weight: 600;
	border-radius: 4rpx;
	line-height: 1.4;
	white-space: nowrap;
}
.type-tag-sales { background: #ecf5ff; color: #2979ff; }   /* 大货 = 蓝 */
.type-tag-sample { background: #fdf6ec; color: #ff9900; }  /* 打样 = 橙 */
.type-tag-direct { background: #f0f1f2; color: #303133; } /* 直接出库 = 深灰，不再弱化 */
.customer {
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: pointer;
	transition: color 0.15s ease;
}
.customer:hover {
	color: #2979ff;
}
.time-text {
	font-size: 12px;
	color: #909399;
	margin-top: 2px;
}
/* 日期列：日期 + 时间同行（baseline 对齐，时间用小灰字；无时间则只显示日期） */
.date-time {
	display: inline-flex;
	align-items: baseline;
	gap: 6px;
	white-space: nowrap;
}
/* 状态列图标：去掉圆圈背景，图标直显，色=状态色，hover 轻微降透明度给反馈 */
.status-dot {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	padding: 4rpx;
	cursor: default;
	user-select: none;
	flex-shrink: 0;
	transition: opacity 0.15s ease;
}
.status-dot:hover { opacity: 0.65; }

/* ════════════════════════════════════════════════
 * 详情抽屉（码单风格：紧凑、信息密度高、无装饰）
 *   - 顶部只保留单号（无 eyebrow）
 *   - label-value 行；section 分隔用细线+小标签
 *   - 明细非卡片化（行+缩进列细码）
 *   - 底部独立合计横条
 *   - 整体 padding 收窄、阴影减弱
 * ════════════════════════════════════════════════ */
.detail-popup {
	width: 880rpx;
	max-width: 90vw;
	height: 100vh;
	background: #fff;
	border-radius: 8rpx 0 0 8rpx;
	box-shadow: -2px 0 16px rgba(0, 0, 0, 0.08);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* 顶部条：单号 + × */
.detail-header {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 20rpx 32rpx;
	border-bottom: 1rpx solid #ebeef5;
}
.detail-no {
	font-family: 'SFMono-Regular', Consolas, monospace;
	font-size: 16px;
	font-weight: 700;
	color: #303133;
	letter-spacing: 0.5rpx;
}
.detail-close {
	width: 30px;
	height: 30px;
	line-height: 26px;
	text-align: center;
	font-size: 22px;
	color: #909399;
	cursor: pointer;
	border-radius: 3px;
	transition: all 0.15s ease;
}
.detail-close:hover { background: #f0f1f2; color: #303133; }

/* 滚动区 */
.detail-scroll { flex: 1; }
.detail-loading {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 100rpx 0;
	color: #909399;
	font-size: 14px;
}
.detail-body { padding: 24rpx 32rpx 0; }

/* ── label-value 段 ── */
.kv-section {
	margin-bottom: 24rpx;
}
.kv-section.first {
	margin-top: 4rpx;
}
.kv-row {
	display: flex;
	align-items: baseline;
	padding: 8rpx 0;
	gap: 18rpx;
}
.kv-row-stack {
	align-items: flex-start;
}
.kv-k {
	flex-shrink: 0;
	width: 90rpx;
	font-size: 13px;
	color: #606266;
	text-align: left;
	font-weight: 500;
}
.kv-v {
	flex: 1;
	font-size: 15px;
	color: #303133;
	word-break: break-all;
	line-height: 1.55;
}
.kv-v.mono {
	font-family: 'SFMono-Regular', Consolas, monospace;
	font-size: 14px;
}
.kv-v .phone {
	font-size: 13px;
	color: #606266;
	margin-left: 8rpx;
}
.time-sm {
	color: #909399;
	font-size: 13px;
}

/* 状态行：图标 + 文字（去掉小圆点，图标直显） */
.kv-v-status {
	display: flex;
	align-items: center;
	gap: 8rpx;
}
.status-dot-sm {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
}
.status-text {
	font-size: 14px;
	color: #303133;
}

/* section 分隔线：码单风的细线 + 左侧小方块 + 文字 */
.section-divider {
	display: flex;
	align-items: center;
	font-size: 12px;
	font-weight: 600;
	color: #606266;
	letter-spacing: 1rpx;
	margin: 28rpx 0 14rpx;
	padding-bottom: 8rpx;
	border-bottom: 1rpx solid #ebeef5;
}
.section-divider::before {
	content: '';
	display: inline-block;
	width: 6rpx;
	height: 14rpx;
	background: #303133;
	margin-right: 8rpx;
	border-radius: 1rpx;
}

/* 缩略图（面单最小化） */
.kv-row-thumb {
	align-items: flex-start;
	padding-top: 14rpx;
}
.thumb-wrap {
	display: inline-flex;
	flex-direction: column;
	align-items: flex-start;
	cursor: zoom-in;
}
.detail-express-thumb {
	width: 96rpx;
	height: 96rpx;
	border: 1rpx solid #ebeef5;
	border-radius: 4rpx;
	background: #fafbfc;
}
.thumb-hint {
	font-size: 11px;
	color: #c0c4cc;
	margin-top: 4rpx;
}

/* ── 出货明细：码单行（不卡片化，节省空间） ── */
.items-list {
	border-top: 1rpx solid #ebeef5;
}
.item-line {
	padding: 18rpx 12rpx;
	border-bottom: 1rpx solid #ebeef5;
	border-radius: 4rpx;
	margin: 0 -12rpx;
	transition: background 0.15s ease;
}
.item-line:last-child { border-bottom: none; }
.item-line:hover { background: #fafbfc; }

.item-line-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14rpx;
}
.item-line-summary {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8rpx;
	line-height: 1.4;
}
/* 右侧数据组：数量 pill + 金额（靠右对齐，紧贴在一起） */
.item-line-right {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 10rpx;
	white-space: nowrap;
}
.item-name-text {
	font-size: 15px;
	font-weight: 600;
	color: #303133;
}

/* 颜色 pill：浅灰底 + 中深色字，中文（不 tabular-nums） */
.pill-color {
	display: inline-flex;
	align-items: center;
	height: 26rpx;
	padding: 0 10rpx;
	font-size: 12px;
	font-weight: 500;
	color: #606266;
	background: #f0f1f2;
	border-radius: 13rpx;
	line-height: 1;
	white-space: nowrap;
}

/* 数量 pill：浅蓝底 + 蓝字，等宽数字（数字感强烈，是行内视觉锚点） */
.pill-qty {
	display: inline-flex;
	align-items: center;
	height: 26rpx;
	padding: 0 10rpx;
	font-family: 'SF Mono', 'SF Mono Pro', 'SFMono-Regular', Consolas, monospace;
	font-size: 12px;
	font-weight: 700;
	color: #2979ff;
	background: #e8f3ff;
	border-radius: 13rpx;
	line-height: 1;
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum" 1, "lnum" 1;
	letter-spacing: 0.2rpx;
}
/* 需求中的 pill：橙色（区分"已配货"和"未配货"两种业务状态） */
.pill-qty-pending {
	color: #ff9900;
	background: #fdf6ec;
}

/* 金额：每行最醒目的数字（等宽数字 + 加大字号 + 字重 700） */
.item-amount {
	font-size: 17px;
	font-weight: 700;
	color: #ff5b3c;
	font-family: 'SF Mono', 'SF Mono Pro', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum" 1, "lnum" 1;
	letter-spacing: 0.3rpx;
	flex-shrink: 0;
}

/* 库位行：独立小字行（单行展示，hover 不再变色） */
.item-loc-line {
	display: flex;
	align-items: center;
	gap: 4rpx;
	margin-top: 8rpx;
	font-size: 12px;
	color: #909399;
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	letter-spacing: 0.3rpx;
}
.item-loc-icon { font-size: 11px; }

/* 细码：横向 chip 列表（去序号、去单位：米数+短码一格，自动换行） */
/* 细码：横向分段 chip 列表（米数段蓝底 + 短码段白底，pill 圆角；自动换行）
 * 设计要点：双段拼成一个 chip，让「数量」和「ID」视觉分组；扫读时一眼能区分两个字段 */
.item-rolls {
	margin-top: 12rpx;
	display: flex;
	flex-wrap: wrap;
	gap: 10rpx;
}
.roll-chip {
	display: inline-flex;
	align-items: stretch;
	padding: 0;
	border: 1rpx solid #d4e3ff;
	border-radius: 14rpx;
	background: #fff;
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	line-height: 1;
	white-space: nowrap;
	overflow: hidden;
	transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.roll-chip:hover {
	border-color: #2979ff;
	box-shadow: 0 1px 4px rgba(41, 121, 255, 0.18);
}

/* 米数段：左半边，浅蓝底 + 主蓝字，等宽数字（视觉锚点） */
.roll-chip-meters {
	display: inline-flex;
	align-items: center;
	padding: 6rpx 12rpx;
	font-size: 14px;
	font-weight: 700;
	color: #2979ff;
	background: #e8f3ff;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum" 1, "lnum" 1;
	letter-spacing: 0.2rpx;
}

/* 短码段：右半边，白底 + 中深色字，字号加大 + 字距撑开（提高辨识） */
.roll-chip-id {
	display: inline-flex;
	align-items: center;
	padding: 6rpx 12rpx;
	font-size: 13px;
	font-weight: 500;
	color: #606266;
	background: #fff;
	letter-spacing: 0.5rpx;
	border-left: 1rpx solid #ebeef5;
}

/* ── 合计横条（码单底栏） ── */
.kv-total {
	display: flex;
	align-items: baseline;
	justify-content: flex-end;
	gap: 20rpx;
	padding: 24rpx 0;
	margin-top: 18rpx;
	margin-bottom: 40rpx;
	border-top: 2rpx solid #303133;
}
.total-label {
	font-size: 13px;
	color: #606266;
	letter-spacing: 1rpx;
	margin-right: auto;
}
/* 合计条数/米数：等宽 + 15px + 600 */
.total-figures {
	font-size: 15px;
	font-weight: 600;
	color: #303133;
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum" 1, "lnum" 1;
}
/* 合计金额：22px + 字间距收紧，让数字成为整页最重锚点 */
.total-amount {
	font-size: 22px;
	font-weight: 700;
	color: #ff5b3c;
	font-family: 'SF Mono', 'SF Mono Pro', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
	font-feature-settings: "tnum" 1, "lnum" 1;
	letter-spacing: 0.3rpx;
}
</style>
