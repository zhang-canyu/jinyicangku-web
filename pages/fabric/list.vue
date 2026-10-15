<template>
	<view class="page">
		<!-- ── 页面头：标题 + 统计 + 主操作 ── -->
		<view class="uni-header">
			<uni-stat-breadcrumb class="uni-stat-breadcrumb-on-phone" />
		</view>

		<view class="page-container">
			<view class="page-header">
				<view class="page-header-info">
					<view class="page-title">面料管理</view>
					<view class="page-desc">
						<text v-if="!loading">共 {{ list.length }} 个品名 · {{ totalColors }} 个颜色</text>
						<text v-else>加载中…</text>
					</view>
				</view>
				<button class="btn-primary" @click="openAddFabric">
					<text class="btn-primary-icon">＋</text>
					<text>新增品名</text>
				</button>
			</view>

			<!-- ── 双栏卡：左品名列表 / 右颜色管理 ── -->
			<view class="master-detail">
				<!-- 左栏：品名 -->
				<view class="master">
					<view class="master-search">
						<text class="search-icon">🔍</text>
						<input class="search-input" type="text" v-model="keyword"
							placeholder="搜索品名 / 颜色" confirm-type="search"
							@confirm="load" @input="onSearchInput" />
						<text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
					</view>

					<scroll-view class="master-scroll" scroll-y>
						<view v-if="loading" class="master-state">加载中…</view>
						<view v-else-if="!list.length" class="master-state">
							{{ keyword ? '无匹配结果' : '暂无品名' }}</view>
						<view v-else v-for="f in list" :key="f.id" class="master-item"
							:class="{ active: f.id === selectedId }" @click="selectFabric(f)">
							<text class="master-item-name">{{ f.name }}</text>
							<text class="master-item-count">{{ (f.colors || []).length }}色</text>
						</view>
					</scroll-view>
				</view>

				<!-- 右栏：选中品名的颜色 -->
				<view class="detail">
					<template v-if="selectedFabric">
						<view class="detail-header">
							<view class="detail-title-wrap">
								<text class="detail-title">{{ selectedFabric.name }}</text>
								<text class="detail-count-pill">共 {{ (selectedFabric.colors || []).length }} 色</text>
							</view>
							<view class="detail-ops">
								<text class="op-link" @click="openEdit(selectedFabric)">编辑</text>
								<text class="op-link op-danger" @click="confirmRemoveFabric(selectedFabric)">删除</text>
								<button class="btn-primary btn-sm" @click="openLabelPrint(selectedFabric)">
									<text class="btn-primary-icon">🖨</text>
									<text>打码单</text>
								</button>
								<button class="btn-primary btn-sm" @click="openAddColor(selectedFabric)">
									<text class="btn-primary-icon">＋</text>
									<text>添加颜色</text>
								</button>
							</view>
						</view>

						<!-- 规格条：产品编号 / 门幅 / 克重（标签打印直接取这三项） -->
						<view class="detail-specs">
							<view v-if="selectedFabric.code" class="spec-item">
								<text class="spec-k">产品编号</text>
								<text class="spec-v">{{ selectedFabric.code }}</text>
							</view>
							<view v-if="selectedFabric.width" class="spec-item">
								<text class="spec-k">门幅</text>
								<text class="spec-v">{{ selectedFabric.width }}</text>
							</view>
							<view v-if="selectedFabric.weight" class="spec-item">
								<text class="spec-k">克重</text>
								<text class="spec-v">{{ selectedFabric.weight }}</text>
							</view>
							<text v-if="!hasSpecs(selectedFabric)" class="spec-empty">
								未设置规格，点右侧「编辑」补充产品编号 / 门幅 / 克重
							</text>
						</view>

						<!-- 元信息条：操作提示 -->
						<view v-if="(selectedFabric.colors || []).length" class="detail-toolbar">
							<!-- #ifdef H5 -->
							<text class="detail-toolbar-hint">拖动颜色调整顺序 · 点击 × 移除</text>
							<!-- #endif -->
							<!-- #ifndef H5 -->
							<text class="detail-toolbar-hint">点 ↑↓ 调整顺序 · 点 × 移除</text>
							<!-- #endif -->
						</view>

						<view class="detail-scroll">
							<view v-if="(selectedFabric.colors || []).length" class="color-grid">
								<!-- #ifdef H5 -->
								<view v-for="(c, idx) in selectedFabric.colors" :key="c.id" class="color-chip"
									:class="{ 'color-chip-dragging': dragSrcIdx === idx, 'color-chip-drag-over': dragOverIdx === idx }"
									:hover-class="'color-chip-hover'" hover-stay-time="100"
									draggable="true"
									@dragstart="onColorDragStart($event, idx)"
									@dragover.prevent="onColorDragOver($event, idx)"
									@dragleave="onColorDragLeave(idx)"
									@drop="onColorDrop($event, idx)"
									@dragend="onColorDragEnd"
									@click="confirmRemoveColor(selectedFabric, c)">
									<text class="color-chip-index">{{ idx + 1 }}</text>
									<text class="color-chip-name">{{ c.name }}</text>
									<text class="color-chip-x" @click.stop="confirmRemoveColor(selectedFabric, c)">×</text>
								</view>
								<!-- #endif -->
								<!-- #ifndef H5 -->
								<view v-for="(c, idx) in selectedFabric.colors" :key="c.id" class="color-chip"
									:hover-class="'color-chip-hover'" hover-stay-time="100"
									@click="confirmRemoveColor(selectedFabric, c)">
									<text class="color-chip-index">{{ idx + 1 }}</text>
									<text class="color-chip-name">{{ c.name }}</text>
									<text class="color-chip-arrow" :class="{ disabled: idx === 0 }" @click.stop="moveColor(selectedFabric, idx, -1)">↑</text>
									<text class="color-chip-arrow" :class="{ disabled: idx === selectedFabric.colors.length - 1 }" @click.stop="moveColor(selectedFabric, idx, 1)">↓</text>
									<text class="color-chip-x" @click.stop="confirmRemoveColor(selectedFabric, c)">×</text>
								</view>
								<!-- #endif -->
							</view>
							<view v-else class="detail-empty">
								<view class="detail-empty-icon-wrap">
									<text class="detail-empty-icon">🎨</text>
								</view>
								<view class="detail-empty-text">尚无颜色</view>
								<button class="btn-primary detail-empty-btn" @click="openAddColor(selectedFabric)">添加第一个颜色</button>
							</view>
						</view>
					</template>

					<!-- 无选中：搜索无结果 / 列表为空 -->
					<view v-else class="detail-empty">
						<view class="detail-empty-icon-wrap">
							<text class="detail-empty-icon">{{ keyword ? '🔍' : '📦' }}</text>
						</view>
						<view class="detail-empty-text">{{ keyword ? '没有匹配的品名 / 颜色' : '暂无品名' }}</view>
						<button v-if="!keyword" class="btn-primary detail-empty-btn" @click="openAddFabric">新增第一个品名</button>
					</view>
				</view>
			</view>
		</view>

		<!-- ── 编辑弹窗：新增品名 / 编辑品名（含规格） / 添加颜色 共用 ── -->
		<uni-popup ref="editPopup" type="center" :mask-click="false">
			<view class="edit-card">
				<view class="edit-title">{{ editTitle }}</view>

				<!-- 颜色模式：单个输入 -->
				<template v-if="editMode === 'addColor'">
					<view v-if="editFabric" class="edit-sub">品名「{{ editFabric.name }}」· 输入已有颜色名将自动复用</view>
					<input class="edit-input" type="text" v-model="editValue" :placeholder="editPlaceholder"
						:focus="editFocus" @confirm="submitEdit" />
				</template>

				<!-- 品名模式：品名 + 规格三字段（规格供打码单自动带出） -->
				<template v-else>
					<view class="edit-sub">规格字段用于打码单自动带出，可留空</view>
					<view class="edit-fields">
						<view class="edit-field">
							<text class="edit-field-label">品名</text>
							<input class="edit-input edit-input-inline" type="text" v-model="editValue"
								placeholder="如：全棉四面弹" :focus="editFocus" @confirm="submitEdit" />
						</view>
						<view class="edit-field">
							<text class="edit-field-label">产品编号</text>
							<input class="edit-input edit-input-inline" type="text" v-model="editCode"
								placeholder="如：A-102" />
						</view>
						<view class="edit-field">
							<text class="edit-field-label">门幅</text>
							<view class="edit-input-wrap">
								<input class="edit-input edit-input-inline" type="text" v-model="editWidth"
									placeholder="155" />
								<text v-if="showSpecUnit(editWidth)" class="edit-unit">cm</text>
							</view>
						</view>
						<view class="edit-field">
							<text class="edit-field-label">克重</text>
							<view class="edit-input-wrap">
								<input class="edit-input edit-input-inline" type="text" v-model="editWeight"
									placeholder="180" />
								<text v-if="showSpecUnit(editWeight)" class="edit-unit">g</text>
							</view>
						</view>
					</view>
				</template>

				<view class="edit-ops">
					<button class="btn-plain" @click="closeEdit">取消</button>
					<button class="btn-primary btn-edit-ok" :class="{ disabled: !editValue.trim() }"
						@click="submitEdit">确定</button>
				</view>
			</view>
		</uni-popup>

		<!-- #ifndef H5 -->
		<fix-window />
		<!-- #endif -->
	</view>
</template>

<script>
/* 面料管理（双栏 Master-Detail 布局）：左栏品名列表，右栏管理选中品名的颜色
 * 云对象 fabric-manage（部署于 锦一仓库 主项目）：
 *   list / addFabric / updateFabric / removeFabric / addColor / removeColor
 * 权限（后端校验）：管理员全操作；营业员可维护品名与颜色；仓管只读 */
const fabricCo = uniCloud.importObject('fabric-manage', { customUI: true })

/* 搜索防抖（ms） */
const SEARCH_DEBOUNCE = 300

/* ── 规格字段默认单位（门幅 cm / 克重 g）
 * 输入框只填数值，单位在右侧常驻展示，提交时自动补齐；
 * 若用户自己写了单位（如 180g/m²），则原样保留、不再追加后缀 ── */
const SPEC_UNITS = { width: 'cm', weight: 'g' }
/* 值里出现字母或汉字 = 用户已自带单位 */
function hasUnitText(v) {
	return /[a-zA-Z\u4e00-\u9fa5]/.test(String(v || ''))
}
/* 提交前：纯数值自动补默认单位 */
function withSpecUnit(v, unit) {
	const s = String(v || '').trim()
	if (!s || hasUnitText(s)) return s
	return s + unit
}
/* 回填时：去掉末尾的默认单位，输入框只留数值（单位交给右侧后缀展示）
 * 单位按字面转义后再拼正则，所以换成 g/m² 这类含特殊字符的单位也能正确剥离 */
function stripSpecUnit(v, unit) {
	const s = String(v || '').trim()
	const esc = String(unit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return s.replace(new RegExp('\\s*' + esc + '$', 'i'), '').trim()
}

export default {
	data() {
		return {
			keyword: '',
			list: [],
			loading: false,
			selectedId: '',       // 当前选中品名 id（右栏渲染对象）
			/* 编辑弹窗状态 */
			editMode: '',         // '' | addFabric | edit | addColor
			editFabric: null,
			editValue: '',
			/* 拖拽高亮状态：-1 表示无；H5 端用于驱动 .color-chip-dragging / .color-chip-drag-over */
			dragSrcIdx: -1,
			dragOverIdx: -1,
			editCode: '',         // 产品编号
			editWidth: '',        // 门幅
			editWeight: '',       // 克重
			editFocus: false,
			searchTimer: null,
		}
	},
	computed: {
		totalColors() {
			return this.list.reduce((s, f) => s + (f.colors || []).length, 0)
		},
		selectedFabric() {
			return this.list.find((f) => f.id === this.selectedId) || null
		},
		editTitle() {
			if (this.editMode === 'addColor') return '添加颜色'
			if (this.editMode === 'edit') return '编辑品名'
			return '新增品名'
		},
		editPlaceholder() {
			if (this.editMode === 'addColor') return '颜色名称，如：漂白 / 藏青'
			return '品名，如：全棉四面弹'
		},
	},
	onShow() {
		this.load()
	},
	methods: {
		/* ── 数据 ── */
		async load(preselectId) {
			this.loading = true
			try {
				const res = await fabricCo.list({ keyword: this.keyword })
				if (res && res.code === 0) {
					this.list = res.data.list || []
				} else {
					this.list = []
				}
			} catch (e) {
				this.list = []
			} finally {
				this.loading = false
			}
			this.ensureSelection(preselectId)
		},
		/* 选中态维护：优先 preselectId（新增后选中新项），否则保持当前选中，失效时回落到第一条 */
		ensureSelection(preselectId) {
			if (preselectId && this.list.some((f) => f.id === preselectId)) {
				this.selectedId = preselectId
				return
			}
			if (!this.list.some((f) => f.id === this.selectedId)) {
				this.selectedId = this.list.length ? this.list[0].id : ''
			}
		},
		/* 输入防抖：停止输入 300ms 后自动搜索 */
		onSearchInput() {
			clearTimeout(this.searchTimer)
			this.searchTimer = setTimeout(() => this.load(), SEARCH_DEBOUNCE)
		},
		clearSearch() {
			this.keyword = ''
			this.load()
		},
		selectFabric(f) {
			this.selectedId = f.id
		},
		/* 快捷入口：跳到独立打印页，预选当前品名+全部颜色 */
		openLabelPrint(f) {
			const colors = (f.colors || []).map((c) => c.id).join(',')
			uni.navigateTo({ url: `/pages/label-print/list?fabricId=${f.id}&colorIds=${colors}` })
		},

		/* ── 编辑弹窗 ── */
		openAddFabric() {
			this.editMode = 'addFabric'
			this.editFabric = null
			this.editValue = ''
			this.editCode = ''
			this.editWidth = ''
			this.editWeight = ''
			this.$refs.editPopup.open()
			this.focusInput()
		},
		/* 编辑品名：改名 + 产品编号 / 门幅 / 克重（规格供打码单自动带出） */
		openEdit(f) {
			this.editMode = 'edit'
			this.editFabric = f
			this.editValue = f.name || ''
			this.editCode = f.code || ''
			// 门幅 / 克重回填时剥掉默认单位，只把数值放进输入框（单位由右侧后缀展示）
			this.editWidth = stripSpecUnit(f.width, SPEC_UNITS.width)
			this.editWeight = stripSpecUnit(f.weight, SPEC_UNITS.weight)
			this.$refs.editPopup.open()
			this.focusInput()
		},
		hasSpecs(f) { return !!(f && (f.code || f.width || f.weight)) },
		/* 输入框右侧的默认单位：值里已自带单位时隐藏，避免出现「180g/m² g」 */
		showSpecUnit(v) {
			return !hasUnitText(v)
		},
		openAddColor(f) {
			this.editMode = 'addColor'
			this.editFabric = f
			this.editValue = ''
			this.$refs.editPopup.open()
			this.focusInput()
		},
		focusInput() {
			// 等弹窗渲染完成再聚焦（H5 下 uni-popup 动画期间 focus 会失效）
			this.editFocus = false
			setTimeout(() => { this.editFocus = true }, 250)
		},
		closeEdit() {
			this.$refs.editPopup.close()
			this.editMode = ''
		},
		async submitEdit() {
			const v = String(this.editValue || '').trim()
			if (!v) {
				uni.showToast({ title: this.editMode === 'addColor' ? '请输入颜色名称' : '请输入品名', icon: 'none' })
				return
			}
			const mode = this.editMode
			const fabric = this.editFabric
			// 规格：纯数值自动补默认单位（门幅 cm / 克重 g），已自带单位则原样保留
			const width = withSpecUnit(this.editWidth, SPEC_UNITS.width)
			const weight = withSpecUnit(this.editWeight, SPEC_UNITS.weight)
			try {
				let res
				if (mode === 'addFabric') {
					res = await fabricCo.addFabric({
						name: v,
						code: this.editCode,
						width,
						weight,
					})
				} else if (mode === 'edit') {
					res = await fabricCo.updateFabric({
						id: fabric.id,
						name: v,
						code: this.editCode,
						width,
						weight,
					})
				} else if (mode === 'addColor') {
					res = await fabricCo.addColor({ fabricId: fabric.id, name: v })
				} else {
					return
				}
				if (res && res.code === 0) {
					this.closeEdit()
					uni.showToast({ title: '已保存', icon: 'success' })
					// 新增后选中新项；其他操作保持/修复当前选中
					this.load(mode === 'addFabric' ? res.data.id : undefined)
				} else {
					uni.showToast({ title: (res && res.message) || '保存失败', icon: 'none' })
				}
			} catch (e) {
				uni.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
			}
		},

		/* ── 删除（确认后调用，后端校验库存引用） ── */
		confirmRemoveFabric(f) {
			uni.showModal({
				title: '删除品名',
				content: `确定删除「${f.name}」？存在库存记录时无法删除。`,
				confirmText: '删除',
				success: async (m) => {
					if (!m.confirm) return
					try {
						const res = await fabricCo.removeFabric({ id: f.id })
						if (res && res.code === 0) {
							uni.showToast({ title: '已删除', icon: 'success' })
							// 删除当前选中项后 ensureSelection 自动回落到第一条
							this.load()
						} else {
							uni.showToast({ title: (res && res.message) || '删除失败', icon: 'none' })
						}
					} catch (e) {
						uni.showToast({ title: (e && e.message) || '删除失败', icon: 'none' })
					}
				},
			})
		},
		confirmRemoveColor(f, c) {
			uni.showModal({
				title: '移除颜色',
				content: `从「${f.name}」移除颜色「${c.name}」？`,
				confirmText: '移除',
				success: async (m) => {
					if (!m.confirm) return
					try {
						const res = await fabricCo.removeColor({ id: c.id, fabricId: f.id })
						if (res && res.code === 0) {
							uni.showToast({ title: res.data && res.data.unlinked ? '已解除关联（仍被库存/品名引用）' : '已移除', icon: 'none' })
							this.load()
						} else {
							uni.showToast({ title: (res && res.message) || '移除失败', icon: 'none' })
						}
					} catch (e) {
						uni.showToast({ title: (e && e.message) || '移除失败', icon: 'none' })
					}
				},
			})
		},

		/* ═══ 颜色顺序调整：H5 拖拽 / 非 H5 ↑↓ ═══
		 * 统一保存：乐观更新 → 调 sortColors → 失败回滚 ── */
		async commitColorSort(fabric, nextColors) {
			const prev = fabric.colors
			fabric.colors = nextColors
			try {
				const res = await fabricCo.sortColors({
					fabricId: fabric.id,
					colorIds: nextColors.map((c) => c.id),
				})
				if (!res || res.code !== 0) {
					fabric.colors = prev
					uni.showToast({ title: (res && res.message) || '排序失败', icon: 'none' })
				}
			} catch (e) {
				fabric.colors = prev
				uni.showToast({ title: (e && e.message) || '排序失败', icon: 'none' })
			}
		},
		/* H5 拖拽事件（被 #ifdef H5 模板包住，非 H5 端不会触发） */
		onColorDragStart(e, idx) {
			this.dragSrcIdx = idx
			this.dragOverIdx = -1
			if (e && e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
		},
		onColorDragOver(e, idx) {
			this.dragOverIdx = idx
			if (e && e.dataTransfer) e.dataTransfer.dropEffect = 'move'
		},
		onColorDragLeave(idx) {
			if (this.dragOverIdx === idx) this.dragOverIdx = -1
		},
		async onColorDrop(e, targetIdx) {
			e.preventDefault && e.preventDefault()
			const from = this.dragSrcIdx
			this.dragSrcIdx = -1
			this.dragOverIdx = -1
			if (from < 0 || from === targetIdx) return
			const fabric = this.selectedFabric
			if (!fabric) return
			const arr = fabric.colors.slice()
			const [moved] = arr.splice(from, 1)
			arr.splice(targetIdx, 0, moved)
			await this.commitColorSort(fabric, arr)
		},
		onColorDragEnd() {
			this.dragSrcIdx = -1
			this.dragOverIdx = -1
		},
		/* 非 H5：↑/↓ 按钮 */
		async moveColor(fabric, index, delta) {
			const j = index + delta
			if (j < 0 || j >= fabric.colors.length) return
			const arr = fabric.colors.slice()
			const [moved] = arr.splice(index, 1)
			arr.splice(j, 0, moved)
			await this.commitColorSort(fabric, arr)
		},
	},
}
</script>

<style lang="scss" scoped>
/* ═══════════ 设计语言（对齐 Ant Design Pro / 飞书后台）
 * · 主色 #2979ff（与订单页 type-tag-sales 一致）
 * · 文字层级：#303133 主 / #606266 次 / #909399 弱 / #c0c4cc 占位
 * · 双栏卡 8px 圆角、页面底 #f5f7fa；中栏分隔线 #f0f2f5
 * · 左栏选中浅蓝底 + 左指示条；行 hover 浅灰 ═══════════ */
.page {
	height: 100vh;
	background: #f5f7fa;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.page-container {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	padding: 16px 24px 24px;
}

/* ── 页面头 ── */
.page-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 0 4px 16px;
	flex-shrink: 0;
}
.page-title {
	font-size: 20px;
	font-weight: 600;
	color: #303133;
	line-height: 1.4;
}
.page-desc {
	margin-top: 4rpx;
	font-size: 13px;
	color: #909399;
}

/* ── 按钮 ── */
.btn-primary {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	height: 36px;
	padding: 0 18px;
	background: #2979ff;
	color: #fff;
	font-size: 14px;
	font-weight: 500;
	border: none;
	border-radius: 6px;
	cursor: pointer;
	transition: background 0.15s ease, box-shadow 0.15s ease;
	flex-shrink: 0;
	line-height: 36px;
	margin: 0;
}
.btn-primary:hover {
	background: #1a6ae8;
	box-shadow: 0 2px 8px rgba(41, 121, 255, 0.35);
}
.btn-primary.disabled {
	background: #a0c5ff;
	cursor: not-allowed;
	box-shadow: none;
}
/* 次级强调按钮（保留：备用于浅色场景） */
.btn-ghost {
	background: #fff;
	color: #2979ff;
	border: 1px solid #2979ff;
	padding: 0 14px;
	height: 32px;
	line-height: 30px;
	font-weight: 400;
}
.btn-ghost:hover {
	background: rgba(41, 121, 255, 0.06);
	box-shadow: none;
	border-color: #2979ff;
}
/* 小尺寸主按钮（页内主操作：右栏「添加颜色」） */
.btn-sm {
	height: 32px;
	padding: 0 14px;
	font-size: 13px;
	line-height: 30px;
	font-weight: 500;
}
.btn-sm .btn-primary-icon {
	font-size: 14px;
}
.btn-plain {
	height: 36px;
	padding: 0 18px;
	background: #fff;
	color: #606266;
	font-size: 14px;
	border: 1px solid #dcdfe6;
	border-radius: 6px;
	cursor: pointer;
	transition: all 0.15s ease;
	line-height: 34px;
	margin: 0;
}
.btn-plain:hover {
	color: #2979ff;
	border-color: #2979ff;
}
.btn-primary-icon {
	font-size: 15px;
	line-height: 1;
}

/* ── 双栏布局：占满页面剩余空间（不限制 max-width） ── */
.master-detail {
	flex: 1;
	min-height: 0;
	display: flex;
	background: #fff;
	border-radius: 8px;
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
	overflow: hidden;
}

/* 左栏：品名列表 */
.master {
	flex-shrink: 0;
	width: 264px;
	border-right: 1px solid #f0f2f5;
	display: flex;
	flex-direction: column;
}
.master-search {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 44px;
	padding: 0 14px;
	border-bottom: 1px solid #f0f2f5;
	flex-shrink: 0;
}
.search-icon {
	font-size: 13px;
	color: #909399;
	flex-shrink: 0;
}
.search-input {
	flex: 1;
	height: 30px;
	font-size: 13px;
	color: #303133;
	background: transparent;
}
.search-clear {
	flex-shrink: 0;
	width: 16px;
	height: 16px;
	line-height: 14px;
	text-align: center;
	border-radius: 50%;
	background: #c0c4cc;
	color: #fff;
	font-size: 11px;
	cursor: pointer;
}
.search-clear:hover {
	background: #909399;
}
.master-scroll {
	flex: 1;
	min-height: 0;
}
.master-state {
	padding: 40px 16px;
	text-align: center;
	font-size: 13px;
	color: #909399;
}
.master-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 12px 0 14px;
	height: 40px;
	cursor: pointer;
	position: relative;
	transition: background 0.12s ease;
	user-select: none;
}
.master-item:hover {
	background: #f5f7fa;
}
.master-item.active {
	background: rgba(41, 121, 255, 0.06);
}
.master-item.active::before {
	content: '';
	position: absolute;
	left: 0;
	top: 8px;
	bottom: 8px;
	width: 3px;
	border-radius: 2px;
	background: #2979ff;
}
.master-item-name {
	flex: 1;
	min-width: 0;
	font-size: 14px;
	color: #303133;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.master-item.active .master-item-name {
	color: #2979ff;
	font-weight: 600;
}
.master-item-count {
	flex-shrink: 0;
	font-size: 12px;
	color: #909399;
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
}

/* 右栏：颜色管理 */
.detail {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	background: #fff;
}
/* 右栏 hero：与左栏等高的页内头部，更大字号 + 计数 pill + 主操作 */
.detail-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	height: 64px;
	padding: 0 24px;
	border-bottom: 1px solid #e4e7ed;
	flex-shrink: 0;
	background: #fff;
}
.detail-title-wrap {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
}
.detail-title {
	font-size: 18px;
	font-weight: 600;
	color: #1d2129;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	letter-spacing: 0.3px;
}
.detail-count-pill {
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	height: 22px;
	padding: 0 10px;
	font-size: 12px;
	font-weight: 500;
	color: #4e5969;
	background: #f2f3f5;
	border-radius: 11px;
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
}
.detail-ops {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 4px;
}
.op-link {
	padding: 6px 12px;
	font-size: 13px;
	color: #4e5969;
	cursor: pointer;
	border-radius: 6px;
	transition: all 0.15s ease;
	user-select: none;
}
.op-link:hover {
	color: #2979ff;
	background: rgba(41, 121, 255, 0.06);
}
.op-danger:hover {
	color: #f56c6c;
	background: rgba(245, 108, 108, 0.06);
}

/* 元信息条（操作提示，可扩展为工具栏） */
/* 规格条：产品编号 / 门幅 / 克重 */
.detail-specs {
	flex-shrink: 0;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 20px;
	padding: 10px 24px;
	background: #fff;
	border-bottom: 1px solid #f0f2f5;
}
.spec-item {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
}
.spec-k { color: #86909c; }
.spec-v { color: #1d2129; font-weight: 500; font-variant-numeric: tabular-nums; }
.spec-empty { font-size: 12px; color: #c0c4cc; }

.detail-toolbar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 24px;
	background: #fafbfc;
	border-bottom: 1px solid #f0f2f5;
}
.detail-toolbar-hint {
	font-size: 12px;
	color: #86909c;
}
/* 滚动容器：原 <scroll-view> 在小程序里强制 block 渲染导致 flex-wrap/grid 失效，改用普通 view + overflow */
.detail-scroll {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	-webkit-overflow-scrolling: touch;
}

/* 颜色网格：flex-wrap 横排，列数随容器宽度自动换行（grid 在小程序/H5 webview 兼容差） */
.color-grid {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	padding: 24px 32px 32px;
	align-content: flex-start;
}
/* chip：宽度自适应文字 + 内部居中；hover 红边 + 强红影 + 上浮 */
.color-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 36px;
	padding: 0 12px;
	border: 1px solid #e4e7ed;
	border-radius: 8px;
	background: #fff;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
	cursor: pointer;
	transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.2s ease, transform 0.15s ease;
	white-space: nowrap;
	max-width: 100%;
}
.color-chip:hover,
.color-chip-hover {
	border-color: #f56c6c !important;
	background: #fff !important;
	box-shadow: 0 6px 16px rgba(245, 108, 108, 0.18) !important;
	transform: translateY(-1px);
}
.color-chip-name {
	font-size: 14px;
	color: #1d2129;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 240px;
}
.color-chip-x {
	flex-shrink: 0;
	font-size: 13px;
	color: #c9cdd4;
	line-height: 1;
	transition: color 0.15s ease;
}
.color-chip:hover .color-chip-x,
.color-chip-hover .color-chip-x {
	color: #f56c6c;
}

/* 序号徽标：左侧小圆角数字（拖拽 / ↑↓ 之后位置 = idx + 1） */
.color-chip-index {
	flex-shrink: 0;
	min-width: 18px;
	height: 18px;
	padding: 0 5px;
	font-size: 11px;
	line-height: 18px;
	text-align: center;
	color: #fff;
	background: #c0c4cc;
	border-radius: 9px;
	user-select: none;
}
/* 拖拽中：半透明 */
.color-chip.color-chip-dragging {
	opacity: 0.4;
	cursor: grabbing;
}
/* 拖拽目标位置：虚线蓝边 + 浅蓝底（强于默认 hover，红边不再触发） */
.color-chip.color-chip-drag-over {
	border-color: #2979ff !important;
	border-style: dashed;
	background: rgba(41, 121, 255, 0.06) !important;
	box-shadow: none;
	transform: none;
}
/* 非 H5 ↑↓ 按钮 */
.color-chip-arrow {
	flex-shrink: 0;
	font-size: 12px;
	color: #909399;
	cursor: pointer;
	user-select: none;
	padding: 0 2px;
	transition: color 0.15s ease;
}
.color-chip-arrow:hover { color: #2979ff; }
.color-chip-arrow.disabled { color: #dcdfe6; cursor: not-allowed; }
.color-chip-arrow.disabled:hover { color: #dcdfe6; }

/* 右栏空态（无选中 / 无颜色）：圆形图标底 + 文字 + 主按钮 */
.detail-empty {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 40px 0;
}
.detail-empty-icon-wrap {
	width: 80px;
	height: 80px;
	border-radius: 50%;
	background: #f2f3f5;
	display: flex;
	align-items: center;
	justify-content: center;
}
.detail-empty-icon {
	font-size: 36px;
	line-height: 1;
	filter: grayscale(0.2);
}
.detail-empty-text {
	font-size: 14px;
	color: #86909c;
}
.detail-empty-btn {
	margin-top: 4px;
}

/* ── 编辑弹窗 ── */
.edit-card {
	width: 440px;
	max-width: 86vw;
	background: #fff;
	border-radius: 10px;
	box-shadow: 0 8px 40px rgba(0, 0, 0, 0.14);
	padding: 24px 24px 20px;
}
.edit-title {
	font-size: 16px;
	font-weight: 600;
	color: #303133;
}
.edit-sub {
	margin-top: 6px;
	font-size: 12px;
	color: #909399;
}
.edit-input {
	width: auto;
	height: 38px;
	margin: 16px 0 20px;
	padding: 0 12px;
	border: 1px solid #dcdfe6;
	border-radius: 6px;
	font-size: 14px;
	color: #303133;
	transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.edit-input:focus {
	border-color: #2979ff;
	box-shadow: 0 0 0 3px rgba(41, 121, 255, 0.1);
}
/* 品名模式的字段列表：左标签右输入 */
.edit-fields {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin: 16px 0 20px;
}
.edit-field {
	display: flex;
	align-items: center;
	gap: 12px;
}
.edit-field-label {
	flex-shrink: 0;
	width: 62px;
	font-size: 13px;
	color: #606266;
	text-align: right;
}
.edit-input-inline {
	flex: 1;
	min-width: 0;
	margin: 0;
}
/* 带默认单位的输入框：单位贴在输入框内部右侧（对齐 Ant Design 的 suffix 写法） */
.edit-input-wrap {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
	position: relative;
}
.edit-input-wrap .edit-input-inline {
	width: 100%;
	padding-right: 42px;   /* 给右侧单位留位，避免长数值压到单位上 */
}
.edit-unit {
	position: absolute;
	right: 12px;
	top: 50%;
	transform: translateY(-50%);
	font-size: 13px;
	color: #909399;
	pointer-events: none;   /* 不遮挡输入框点击 */
}
.edit-ops {
	display: flex;
	justify-content: flex-end;
	gap: 10px;
}
.btn-edit-ok {
	height: 36px;
	line-height: 36px;
	font-size: 14px;
	padding: 0 18px;
}

/* ── 窄屏：双栏降级为上下两段 ── */
@media (max-width: 768px) {
	.page {
		height: auto;
		min-height: 100vh;
		overflow: visible;
	}
	.master-detail {
		flex-direction: column;
		flex: none;
		height: auto;
	}
	.master {
		width: auto;
		border-right: none;
		border-bottom: 1px solid #f0f2f5;
	}
	.master-scroll {
		max-height: 240px;
	}
	.detail-scroll {
		max-height: 480px;
	}
}
</style>
