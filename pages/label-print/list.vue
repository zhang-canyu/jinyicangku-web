<template>
	<view class="page" @click="closeDropdown">
		<view class="uni-header">
			<uni-stat-breadcrumb class="uni-stat-breadcrumb-on-phone" :hide-last="true" />
		</view>

		<view class="page-container">
			<view class="page-header">
				<view class="page-desc">
					<template v-if="selectedFabricCount">
						<text>{{ selectedFabricText }} · {{ totalColors }} 个颜色</text>
						<text class="page-desc-tip">· 预计 {{ totalSheets }} 张标签</text>
					</template>
					<text v-else>未选择品名</text>
				</view>
				<view class="page-header-ops">
					<button class="btn-plain" @click="resetSelection">清空选择</button>
					<button class="btn-primary" @click="doPrint">
						<text class="btn-primary-icon">🖨</text>
						<text>打印 / 导出 PDF</text>
					</button>
				</view>
			</view>

			<view class="main">
				<!-- 左栏：选品 + 配置 -->
				<view class="left-pane">
					<scroll-view class="left-scroll" scroll-y>
						<!-- ① 标签模板 -->
						<view class="cfg-block">
							<view class="cfg-head" @click="toggleGroup('tpl')">
								<text class="cfg-title">标签模板</text>
								<view class="cfg-caret" :class="{ open: groups.tpl }"></view>
							</view>
							<view v-show="groups.tpl" class="cfg-body">
								<view class="tpl-grid">
									<view v-for="t in templates" :key="t.key" class="tpl-card"
										:class="{ active: template === t.key }" @click="template = t.key">
										<view class="tpl-card-top">
											<text class="tpl-name">{{ t.name }}</text>
											<view v-if="template === t.key" class="tpl-tick"></view>
											<text class="tpl-card-x" @click.stop="removeTpl(t)">×</text>
										</view>
										<text class="tpl-size">{{ t.size }} · 推荐字号 {{ t.fontSize }}px{{ t.builtin ? ' · 预置' : '' }}</text>
									</view>
									<view class="tpl-card tpl-card-add" @click="openAddTpl">
										<text class="tpl-card-add-icon">+</text>
										<text class="tpl-card-add-text">添加模板</text>
									</view>
								</view>
							</view>
						</view>

						<!-- ② 选择品名（单选：选中即收起下拉，并带出该品名全部颜色） -->
						<view class="cfg-block">
							<view class="cfg-head" @click="toggleGroup('fabric')">
								<text class="cfg-title">选择品名</text>
								<text v-if="selectedFabricCount" class="cfg-badge">{{ selectedFabricCount }}</text>
								<view class="cfg-caret" :class="{ open: groups.fabric }"></view>
							</view>
							<view v-show="groups.fabric" class="cfg-body">
								<view v-if="loading" class="cfg-state">加载中…</view>
								<view v-else-if="!fabrics.length" class="cfg-state">暂无品名</view>
								<template v-else>
									<view class="fabric-select-trigger"
										:class="{ open: dropdownOpen, empty: !selectedFabricCount }"
										@click.stop="toggleDropdown">
										<text class="fabric-select-text">{{ selectedFabricText }}</text>
										<view class="fabric-select-arrow"></view>
									</view>

									<!-- 下拉面板：内联在触发按钮正下方，随内容自然撑开 -->
									<view v-if="dropdownOpen" class="dd-panel" @click.stop>
										<view class="dd-search">
											<view class="dd-search-icon">
												<view class="dd-search-glass"></view>
												<view class="dd-search-handle"></view>
											</view>
											<input class="dd-search-input" v-model="fabricKeyword" type="text"
												placeholder="搜索品名" placeholder-class="dd-search-ph"
												:focus="searchFocus" confirm-type="search" @click.stop />
											<view v-if="fabricKeyword" class="dd-search-clear" @click.stop="fabricKeyword = ''">
												<view class="dd-clear-line"></view>
												<view class="dd-clear-line dd-clear-line2"></view>
											</view>
										</view>
										<view class="dd-list">
											<view v-if="!filteredFabrics.length" class="dd-empty">未找到匹配的品名</view>
											<view v-else v-for="f in filteredFabrics" :key="f.id" class="dd-option"
												:class="{ checked: isFabricSelected(f) }" @click="toggleFabric(f)">
												<view class="dd-radio">
													<view v-if="isFabricSelected(f)" class="dd-radio-dot"></view>
												</view>
												<text class="dd-name">{{ f.name }}</text>
												<text class="dd-count">{{ (f.colors || []).length }} 色</text>
											</view>
										</view>
										<view class="dd-foot">
											<text class="dd-foot-text">共 {{ filteredFabrics.length }} 个品名</text>
											<text class="dd-foot-text">{{ selectedFabricCount ? '已选：' + selectedFabricText : '未选择' }}</text>
										</view>
									</view>
								</template>
							</view>
						</view>

						<!-- ③ 打印内容 -->
						<view class="cfg-block">
							<view class="cfg-head" @click="toggleGroup('content')">
								<text class="cfg-title">打印内容</text>
								<text class="cfg-badge">{{ selectedFieldCount }}</text>
								<view class="cfg-caret" :class="{ open: groups.content }"></view>
							</view>
							<view v-show="groups.content" class="cfg-body">
								<view class="fd-chips">
									<view v-for="f in fieldDefs" :key="f.key" class="fd-chip"
										:class="{ on: printFields[f.key] }" @click="toggleField(f.key)">
										<view class="fd-check">
											<view v-if="printFields[f.key]" class="fd-check-mark"></view>
										</view>
										<text class="fd-label">{{ f.label }}</text>
									</view>
								</view>
								<!-- 仅勾选「序号」字段时显示符号配置（影响 H5 预览 + 导出 PDF/HTML） -->
								<view v-if="printFields.idx" class="fd-idx-sep">
									<text class="fd-idx-sep-label">序号符号</text>
									<input class="fd-idx-sep-input" type="text" v-model="idxSep"
										maxlength="3" placeholder="." />
									<text class="fd-idx-sep-tip">空 = 不显示</text>
								</view>
							</view>
						</view>

						<!-- ④ 标签样式 -->
						<view class="cfg-block">
							<view class="cfg-head" @click="toggleGroup('style')">
								<text class="cfg-title">标签样式</text>
								<view class="cfg-caret" :class="{ open: groups.style }"></view>
							</view>
							<view v-show="groups.style" class="cfg-body">
								<view class="st-row">
									<text class="st-label">颜色字号</text>
									<view class="st-right">
										<text v-if="labelStyle.fontSize > 0" class="st-reset" @click="resetFontSize">复位</text>
										<view class="st-stepper">
											<view class="st-btn" @click="bumpFontSize(-1)">−</view>
											<text class="st-value">{{ effFontSize }}px</text>
											<view class="st-btn" @click="bumpFontSize(1)">＋</view>
										</view>
									</view>
								</view>

								<view class="st-row">
									<text class="st-label">品名字号</text>
									<view class="st-right">
										<text v-if="labelStyle.nameSize > 0" class="st-reset" @click="resetNameSize">复位</text>
										<view class="st-stepper">
											<view class="st-btn" @click="bumpNameSize(-1)">−</view>
											<text class="st-value">{{ nameFontSize }}px</text>
											<view class="st-btn" @click="bumpNameSize(1)">＋</view>
										</view>
									</view>
								</view>

								<view class="st-row">
									<text class="st-label">行距</text>
									<view class="st-right">
										<text v-if="labelStyle.rowGap >= 0" class="st-reset" @click="resetRowGap">复位</text>
										<view class="st-stepper">
											<view class="st-btn" @click="bumpRowGap(-0.2)">−</view>
											<text class="st-value">{{ effRowGap }}mm</text>
											<view class="st-btn" @click="bumpRowGap(0.2)">＋</view>
										</view>
									</view>
								</view>

								<view class="st-switches">
									<view class="sw-item" :class="{ on: labelStyle.showHeader }"
										@click="setStyle('showHeader', !labelStyle.showHeader)">
										<view class="sw-box"><view v-if="labelStyle.showHeader" class="sw-mark"></view></view>
										<text>表头品名</text>
									</view>
									<view class="sw-item" :class="{ on: labelStyle.showDivider }"
										@click="setStyle('showDivider', !labelStyle.showDivider)">
										<view class="sw-box"><view v-if="labelStyle.showDivider" class="sw-mark"></view></view>
										<text>分隔线</text>
									</view>
									<view class="sw-item" :class="{ on: labelStyle.showBorder }"
										@click="setStyle('showBorder', !labelStyle.showBorder)">
										<view class="sw-box"><view v-if="labelStyle.showBorder" class="sw-mark"></view></view>
										<text>外边框</text>
									</view>
								</view>
							</view>
						</view>
					</scroll-view>
				</view>

				<!-- 右栏：实时预览（按品名分张） -->
				<view class="right-pane">
					<view class="preview-header">
						<text class="preview-title">实时预览</text>
						<text class="preview-meta">{{ currentTpl.name }} · {{ effFontSize }}px · 共 {{ totalSheets }} 张</text>
					</view>
					<scroll-view class="preview-scroll" scroll-y>
						<view v-if="!labelSheets.length" class="preview-empty">
							<text>请在左侧选择品名</text>
						</view>
						<view v-else class="preview-pages">
							<view v-for="(s, si) in labelSheets" :key="si" class="preview-page"
								:class="pageClass" :style="pageStyle">
								<!-- 表头：品名（字号可单独设置） -->
								<view v-if="labelStyle.showHeader" class="lbl-head">
									<text class="lbl-name" :style="nameStyle">{{ s.fabricName }}</text>
									<text v-for="h in headItems" :key="h.key" class="lbl-head-extra" :style="nameStyle">{{ h.value }}</text>
								</view>

								<!-- 中间属性行（兼容：position 不填的字段，目前无） -->
								<view v-if="attrItems.length" class="lbl-attrs">
									<view v-for="a in attrItems" :key="a.key" class="lbl-attr">
										<text class="lbl-attr-k">{{ a.label }}</text>
										<text class="lbl-attr-v">{{ a.value }}</text>
									</view>
								</view>

								<view v-if="labelStyle.showDivider" class="lbl-rule"></view>

								<!-- 颜色列表（行距由「行距」配置控制） -->
								<view class="lbl-list" :style="listGapStyle">
									<view v-for="c in s.colors" :key="c.id" class="lbl-row">
										<text v-if="printFields.idx" class="lbl-num">{{ c.idx }}{{ idxSep }}</text>
										<text class="lbl-color">{{ c.name }}</text>
									</view>
								</view>

								<!-- 底部属性行：门幅 / 克重（贴底，margin-top:auto） -->
								<view v-if="footerItems.length" class="lbl-attrs-foot">
									<view v-for="a in footerItems" :key="a.key" class="lbl-attr">
										<text class="lbl-attr-k">{{ a.label }}</text>
										<text class="lbl-attr-v">{{ a.value }}</text>
									</view>
								</view>

							</view>
						</view>
					</scroll-view>
				</view>
			</view>
		</view>
	</view>

	<uni-popup ref="addTplPopup" type="center" :mask-click="false">
		<view class="add-tpl-card">
			<view class="add-tpl-title">添加标签模板</view>
			<view class="add-tpl-sub">输入标签纸规格与推荐字号（毫米 / 像素）</view>
			<view class="add-tpl-form">
				<view class="add-tpl-row">
					<text class="add-tpl-label">模板名</text>
					<input class="add-tpl-input" type="text" v-model="newTpl.name" placeholder="如：我的 70×40" />
				</view>
				<view class="add-tpl-row">
					<text class="add-tpl-label">宽度 (mm)</text>
					<input class="add-tpl-input" type="number" v-model="newTpl.w" placeholder="如 70" />
				</view>
				<view class="add-tpl-row">
					<text class="add-tpl-label">高度 (mm)</text>
					<input class="add-tpl-input" type="number" v-model="newTpl.h" placeholder="如 40" />
				</view>
				<view class="add-tpl-row">
					<text class="add-tpl-label">字号 (px)</text>
					<input class="add-tpl-input" type="number" v-model="newTpl.fontSize" placeholder="默认 11" />
				</view>
				<view class="add-tpl-row">
					<text class="add-tpl-label">行高</text>
					<input class="add-tpl-input" type="number" v-model="newTpl.lineHeight" placeholder="默认 1.5" />
				</view>
			</view>
			<view class="add-tpl-actions">
				<button class="btn-plain" @click="$refs.addTplPopup.close()">取消</button>
				<button class="btn-primary" @click="confirmAddTpl">保存</button>
			</view>
		</view>
	</uni-popup>
</template>

<script>
/* 面料标签打印：单张热敏标签 = 1 品名 + 颜色列表（带序号），品名单选
 * 超出每张容量 → 自动分多张，序号连续不重置
 * 门幅 / 克重 / 编号 取自品名档案（fabric-manage.list 返回），无需页面上手填
 * 打印：纯前端 HTML + window.print()（不依赖后端 print 接口）*/
const fabricCo = uniCloud.importObject('fabric-manage', { customUI: true })

/* 标签纸模板：name 显示名 / size 规格 / page 实际打印尺寸 / fontSize 推荐字号 / lineHeight 行高 / builtin 是否系统预置
 * 每张能放多少色不写死，由 paginateColors() 按标签实际尺寸与当前样式实时估算
 * 启动时与用户自定义模板合并（用户可加 / 删任意模板；删预置只是 hiddenBuiltins 过滤，不动源数据） */
const BUILTIN_TEMPLATES = {
	'80x80': { key: '80x80', name: '热敏 80×80', size: '80×80mm', page: { w: '80mm', h: '80mm' }, fontSize: 11, lineHeight: 1.5, builtin: true },
	'100x80': { key: '100x80', name: '热敏 100×80', size: '100×80mm', page: { w: '100mm', h: '80mm' }, fontSize: 12, lineHeight: 1.5, builtin: true },
	'70x50': { key: '70x50', name: '热敏 70×50', size: '70×50mm', page: { w: '70mm', h: '50mm' }, fontSize: 10, lineHeight: 1.4, builtin: true },
	'a4': { key: 'a4', name: 'A4 大标签', size: '210×297mm', page: { w: '210mm', h: '297mm' }, fontSize: 14, lineHeight: 1.6, builtin: true },
}

/* ── 容量估算常量 / 工具（与打印 CSS 的尺寸口径保持一致） ── */
const MM2PX = 3.7795        // 1mm ≈ 3.7795px（96dpi）
const PAGE_PAD_V_MM = 2    // .print-page 上下内边距 2mm
const PAGE_PAD_H_MM = 4    // .print-page 左右内边距 4mm
const COL_GAP_MM = 3        // 颜色列间距 3mm（.lbl-list gap）
const ATTR_GAP_MM = 0.8     // 属性行 margin-top 0.8mm
/* 字符宽度估算（em）：CJK 0.95em，半角 0.55em（较原 1/0.58 各 -5%）
 * 抵消字体实际渲染偏宽的误差（不同字体字宽 0.5~0.6em、CJK 0.95~1.0em），
 * 让 paginateColors 算的"单行能装几个"更接近 CSS 实际渲染结果，
 * 避免"颜色项水平没填满当前行就触发换行/换页"（itemW 偏大 → 误判装不下） */
const textWidthEm = (str) => {
	let w = 0
	for (const ch of String(str)) w += ch.charCodeAt(0) > 0x2e7f ? 0.95 : 0.55
	return w
}

/* ── 可打印字段注册表 ──
 * key 与品名数据字段同名（code 产品编号 / width 门幅 / weight 克重），值直接取品名数据
 * scope:   'fabric' 品名级 → 渲染在品名 / 颜色列表 / 底部三段（按 position 决定）
 *          'color'  颜色级 → 渲染在每个颜色项内（序号 1. 2. 3.）
 * position: 'head'   → 与品名同行（不带 label，只显示值）
 *          'footer' → 标签最底一排（带 label）
 *          不填     → 兼容旧版：渲染在表头下方的属性行（目前无字段用到） */
const PRINT_FIELDS = [
	{ key: 'code',   label: '编号', scope: 'fabric', position: 'head' },
	{ key: 'width',  label: '门幅', scope: 'fabric', position: 'footer' },
	{ key: 'weight', label: '克重', scope: 'fabric', position: 'footer' },
	{ key: 'idx',    label: '序号', scope: 'color' },
]

/* 默认勾选的打印字段 */
const DEFAULT_PRINT_FIELDS = {
	width: true, weight: true, idx: true, code: true,
}

/* 默认标签样式 */
const DEFAULT_LABEL_STYLE = {
	fontSize: 0,          // 0 = 跟随模板推荐字号；> 0 = 手动覆盖（px）
	nameSize: 0,          // 品名字号：0 = 跟随正文字号；> 0 = 手动覆盖（px）
	rowGap: -1,           // 颜色行的行距（mm）：-1 = 未设置，用默认 1.5
	showHeader: true,     // 表头：品名
	showDivider: true,    // 分隔线
	showBorder: false,    // 标签外边框
}

const CONFIG_KEY = 'label-print:config'
const TPL_STORAGE_KEY = 'label-print:templates'      // 用户自定义模板
const TPL_HIDDEN_KEY = 'label-print:hiddenBuiltins'  // 用户主动隐藏的预置 key 列表

export default {
	data() {
		return {
			fabrics: [],
			loading: false,
			template: '80x80',
			selectedColors: {},        // { fabricId: Set<colorId> }：品名单选，最多一个 key（值为该品名全部颜色）
			dropdownOpen: false,       // 品名下拉是否展开
			fabricKeyword: '',         // 下拉内搜索关键词
			searchFocus: false,        // 搜索框自动聚焦状态
			/* ── 标签配置 ── */
			groups: { tpl: true, fabric: true, content: true, style: false },  // 配置分组的展开态
			printFields: { ...DEFAULT_PRINT_FIELDS },                          // 勾选的打印字段
			labelStyle: { ...DEFAULT_LABEL_STYLE },                            // 标签样式
			idxSep: '.',                                                      // 颜色序号后符号（影响 H5 预览 + 导出 PDF/HTML；存 label-print:config）
			/* 实测布局（H5）：从预览 DOM 读到的列表可用高度 / 单行实际高度，用于精确分页 */
			metrics: { listH: 0, rowH: 0 },
			/* 标签模板：用户自定义 + 隐藏的预置 key（合并在 computed.templates 时过滤） */
			customTemplates: [],
			hiddenBuiltins: [],
			/* 添加模板弹窗表单 */
			newTpl: { name: '', w: '', h: '', fontSize: '', lineHeight: '' },
			}
	},
	computed: {
		templates() {
			// 内置（去隐藏）+ 自定义 → 当前可见的模板列表
			const builtins = Object.values(BUILTIN_TEMPLATES).filter((t) => !this.hiddenBuiltins.includes(t.key))
			return [...builtins, ...this.customTemplates]
		},
		currentTpl() {
			return this.templates.find((t) => t.key === this.template) || this.templates[0] || BUILTIN_TEMPLATES['80x80']
		},
		pageWidth() { return this.currentTpl.page.w },
		pageHeight() { return this.currentTpl.page.h },
		/* 生效字号：手动覆盖值优先，否则用模板推荐字号 */
		effFontSize() {
			const s = this.labelStyle.fontSize
			return s > 0 ? s : this.currentTpl.fontSize
		},
		/* 生效品名字号：未单独设置时跟随正文字号 */
		nameFontSize() {
			const s = this.labelStyle.nameSize
			return s > 0 ? s : this.effFontSize
		},
		/* 预览用：仅在单独设置过品名字号时才注入行内样式，未设置则完全交给 CSS */
		nameStyle() {
			return this.labelStyle.nameSize > 0 ? { fontSize: this.labelStyle.nameSize + 'px' } : {}
		},
		/* 生效行距（mm）：未手动设置时用默认值 1.5 */
		effRowGap() {
			const g = this.labelStyle.rowGap
			return g >= 0 ? g : 1.5
		},
		/* 预览用：只覆盖行间距，列间距保持 3mm */
		listGapStyle() {
			const g = this.labelStyle.rowGap
			return g >= 0 ? { rowGap: g + 'mm' } : {}
		},
		pageStyle() {
			return {
				width: this.pageWidth,
				height: this.pageHeight,
				fontSize: this.effFontSize + 'px',
				lineHeight: this.currentTpl.lineHeight,
			}
		},
		/* 预览标签的附加 class（外边框） */
		pageClass() {
			return this.labelStyle.showBorder ? 'pg-bordered' : ''
		},
		/* 当前选中的品名（单选） */
		currentFabric() { return this.selectedFabrics[0] || null },
		/* 属性行：勾选的品名级字段，值取自品名数据（产品编号 / 门幅 / 克重），无值不渲染 */
		/* 头部字段（与品名同行，只显示值、不带 label）：如 编号 */
		headItems() {
			const f = this.currentFabric
			if (!f) return []
			return PRINT_FIELDS
				.filter((d) => d.scope === 'fabric' && d.position === 'head' && this.printFields[d.key])
				.map((d) => ({ key: d.key, value: String(f[d.key] || '').trim() }))
				.filter((it) => it.value)
		},
		/* 底部字段（标签最底一排，带 label）：如 门幅 / 克重 */
		footerItems() {
			const f = this.currentFabric
			if (!f) return []
			return PRINT_FIELDS
				.filter((d) => d.scope === 'fabric' && d.position === 'footer' && this.printFields[d.key])
				.map((d) => ({ key: d.key, label: d.label, value: String(f[d.key] || '').trim() }))
				.filter((it) => it.value)
		},
		/* 中间属性行（兼容：position 不填的字段，目前无；保留以便未来扩展） */
		attrItems() {
			const f = this.currentFabric
			if (!f) return []
			return PRINT_FIELDS
				.filter((d) => d.scope === 'fabric' && !d.position && this.printFields[d.key])
				.map((d) => ({ key: d.key, label: d.label, value: String(f[d.key] || '').trim() }))
				.filter((it) => it.value)
		},
		/* 配置面板字段（门幅 / 克重 / 序号 / 编号） */
		fieldDefs() { return PRINT_FIELDS },
		/* 已勾选字段数量（配置面板徽标） */
		selectedFieldCount() { return Object.keys(this.printFields).filter((k) => this.printFields[k]).length },
		/* 已选品名（单选，0 或 1 个） */
		selectedFabrics() {
			return this.fabrics.filter((f) => (this.selectedColors[f.id] || new Set()).size > 0)
		},
		selectedColorCount() {
			return Object.values(this.selectedColors).reduce((s, set) => s + set.size, 0)
		},
		selectedFabricCount() { return this.selectedFabrics.length },
		/* 触发按钮文本：未选 → 占位；已选 → 该品名 */
		selectedFabricText() {
			const list = this.selectedFabrics
			if (!list.length) return '请选择品名'
			return list[0].name
		},
		/* 下拉列表：按关键词过滤品名（大小写不敏感，空关键词返回全部） */
		filteredFabrics() {
			const kw = (this.fabricKeyword || '').trim().toLowerCase()
			if (!kw) return this.fabrics
			return this.fabrics.filter((f) => (f.name || '').toLowerCase().includes(kw))
		},
		/* ── 核心：把「品名+选中颜色」展开为「按品名拆分的标签页」 ──
		 * 每个品名一张基础标签；颜色超出当前标签纸实际容量时自动拆多张，序号连续 */
		labelSheets() {
			const sheets = []
			for (const f of this.fabrics) {
				const set = this.selectedColors[f.id] || new Set()
				if (!set.size) continue
				const selected = (f.colors || []).filter((c) => set.has(c.id))
				// 序号：1..N 连续，跨多张不重置（先算好，容量估算要用到序号宽度）
				selected.forEach((c, i) => { c.idx = i + 1 })
				for (const colors of this.paginateColors(selected)) {
					sheets.push({ fabricId: f.id, fabricName: f.name, colors })
				}
			}
			return sheets
		},
		totalSheets() { return this.labelSheets.length },
		totalColors() { return this.selectedColorCount },
	},
	watch: {
		/* 任一配置变化 → 立即落盘，下次进入页面自动还原 */
		template() { this.saveConfig() },
		printFields: { deep: true, handler() { this.saveConfig() } },
		labelStyle: { deep: true, handler() { this.saveConfig() } },
		idxSep() { this.saveConfig() },
	},
	onLoad(options = {}) {
		this.loadCustomTemplates()      // 先：填充 customTemplates + hiddenBuiltins，loadConfig 要用
		this.loadConfig()               // 后：校验 cfg.template 时 this.templates 才有完整数据
		const fabricId = options.fabricId
		const colorIds = (options.colorIds || '').split(',').filter(Boolean)
		if (fabricId && colorIds.length) this.preSelect(fabricId, colorIds)
		else this.load()
	},
	/* 每次视图更新后校准分页实测值；值稳定后直接返回，不会造成循环渲染 */
	updated() {
		this.measureLayout()
	},
	methods: {
		/* ── 实测标签布局（H5）──
		 * 估算行高会受字体 / 组件包装影响而偏差，导致提前翻页、标签下方留空；
		 * 这里读取浏览器真实渲染的「列表可用高度」与「单行实际高度」来校准分页
		 * （小程序端无 DOM，自动退回估算） */
		measureLayout() {
			// #ifdef H5
			if (typeof document === 'undefined') return
			const list = document.querySelector('.preview-page .lbl-list')
			const row = document.querySelector('.preview-page .lbl-row')
			if (!list || !row) return
			const listH = list.getBoundingClientRect().height
			const rowH = row.getBoundingClientRect().height
			if (listH <= 0 || rowH <= 0) return
			if (Math.abs(listH - this.metrics.listH) < 0.6 && Math.abs(rowH - this.metrics.rowH) < 0.6) return
			this.metrics = { listH, rowH }
			// #endif
		},
		async load() {
			this.loading = true
			try {
				const res = await fabricCo.list({ keyword: '' })
				if (res && res.code === 0) this.fabrics = res.data.list || []
			} catch (e) { /* ignore */ }
			finally { this.loading = false }
		},
		async preSelect(fabricId, colorIds) {
			await this.load()
			this.$set(this.selectedColors, fabricId, new Set(colorIds))
		},
		isFabricSelected(f) {
			const set = this.selectedColors[f.id]
			return set && set.size > 0
		},
		/* 单选：点品名 = 选中该品名（带出其全部颜色）并立即收起下拉；再点已选中项 = 取消选择 */
		toggleFabric(f) {
			if (this.isFabricSelected(f)) {
				this.selectedColors = {}
			} else {
				// 整体替换，天然保证「有且仅有一个」品名被选中
				this.selectedColors = { [f.id]: new Set((f.colors || []).map((c) => c.id)) }
			}
			this.closeDropdown()
		},
		/* 展开/收起品名下拉：面板内联在触发按钮下方，无需定位计算 */
		toggleDropdown() {
			if (this.dropdownOpen) { this.closeDropdown(); return }
			this.fabricKeyword = ''   // 每次展开重置搜索词，从完整列表开始
			this.searchFocus = false
			this.dropdownOpen = true
			// 展开后自动聚焦搜索框 → 点一次就能直接打字
			this.$nextTick(() => { this.searchFocus = true })
		},
		closeDropdown() {
			if (!this.dropdownOpen) return
			this.dropdownOpen = false
			this.searchFocus = false
		},
		/* ── 按标签实际容量分页 ──
		 * 高度：标签内容高 − 表头 / 属性行 / 分隔线占位 → 可放行数
		 * 宽度：按「序号 + 颜色名」估算项宽，模拟流式填装；装不下换行，行满换页 */
		paginateColors(colors) {
			if (!colors.length) return []
			const tpl = this.currentTpl
			const st = this.labelStyle
			const fs = this.effFontSize
			const lineH = fs * tpl.lineHeight
			const innerW = (parseFloat(tpl.page.w) - PAGE_PAD_H_MM * 2) * MM2PX
			const innerH = (parseFloat(tpl.page.h) - PAGE_PAD_V_MM * 2) * MM2PX
			/* 列表上方各块占用的高度 */
			let usedH = 0
			if (st.showHeader) usedH += this.nameFontSize * tpl.lineHeight
			if (this.footerItems.length) usedH += lineH + ATTR_GAP_MM * MM2PX
			if (st.showDivider) usedH += 2 * MM2PX + 1
			const availH = Math.max(0, innerH - usedH)
			const gapPx = this.effRowGap * MM2PX
			/* 可放行数：优先用 H5 实测值（预览 DOM 的真实高度），否则退回估算
			 * 最后一行不需要行距，故分子 +gapPx */
			const { listH, rowH } = this.metrics
			const maxRows = (listH > 0 && rowH > 0)
				? Math.max(1, Math.floor((listH + gapPx) / (rowH + gapPx)))
				: Math.max(1, Math.floor((availH + gapPx) / (lineH + gapPx)))
			/* 留 2% 宽度余量，抵消字符宽度估算偏差，避免最后一行被挤出标签 */
			const availW = innerW * 0.98
			const gapH = COL_GAP_MM * MM2PX
			const itemW = (c) => {
				const numW = this.printFields.idx ? (String(c.idx).length + this.idxSep.length) * 0.6 * fs : 0
				return numW + textWidthEm(c.name) * fs
			}
			const pages = []
			let rows = 1
			let lineW = 0
			let cur = []
			for (const c of colors) {
				const w = itemW(c)
				if (!cur.length) { cur = [c]; lineW = w; continue }
				if (lineW + gapH + w <= availW) { lineW += gapH + w; cur.push(c); continue }
				if (rows < maxRows) { rows++; lineW = w; cur.push(c); continue }
				pages.push(cur); cur = [c]; rows = 1; lineW = w
			}
			if (cur.length) pages.push(cur)
			return pages
		},
		/* ── 配置面板交互 ── */
		toggleGroup(key) { this.groups[key] = !this.groups[key] },
		toggleField(key) { this.printFields[key] = !this.printFields[key] },
		setStyle(key, value) { this.labelStyle[key] = value },
		/* 字号加减：以当前生效字号为基准（首次操作把模板推荐值转成手动值） */
		bumpFontSize(delta) {
			this.labelStyle.fontSize = Math.min(32, Math.max(6, this.effFontSize + delta))
		},
		resetFontSize() { this.labelStyle.fontSize = 0 },
		/* 品名字号加减：以当前生效品名字号为基准（首次操作把跟随值转成手动值） */
		bumpNameSize(delta) {
			this.labelStyle.nameSize = Math.min(48, Math.max(6, this.nameFontSize + delta))
		},
		resetNameSize() { this.labelStyle.nameSize = 0 },
		/* 行距加减：以当前生效行距为基准，0.2mm 一档（首次操作把布局默认值转成手动值） */
		bumpRowGap(delta) {
			const next = Math.round((this.effRowGap + delta) * 10) / 10
			this.labelStyle.rowGap = Math.min(6, Math.max(0, next))
		},
		resetRowGap() { this.labelStyle.rowGap = -1 },
		saveConfig() {
			try {
				uni.setStorageSync(CONFIG_KEY, {
					template: this.template,
					printFields: this.printFields,
					labelStyle: this.labelStyle,
					idxSep: this.idxSep,
				})
			} catch (e) { /* 存储不可用时静默降级 */ }
		},
		loadConfig() {
			try {
				const cfg = uni.getStorageSync(CONFIG_KEY)
				if (!cfg) return
				if (cfg.template && this.templates.some((t) => t.key === cfg.template)) this.template = cfg.template
				// 只回填当前仍存在的键，避免旧版本已下线的字段/样式（如汇总信息、页脚）污染配置
				if (cfg.printFields) {
					Object.keys(this.printFields).forEach((k) => {
						if (k in cfg.printFields) this.printFields[k] = cfg.printFields[k]
					})
				}
				if (cfg.labelStyle) {
					Object.keys(this.labelStyle).forEach((k) => {
						if (k in cfg.labelStyle) this.labelStyle[k] = cfg.labelStyle[k]
					})
				}
			/* idxSep 是字符串（非对象），单独回填：非字符串视为非法，忽略 */
			if (typeof cfg.idxSep === 'string') this.idxSep = cfg.idxSep
			} catch (e) { /* ignore */ }
		},
		/* ═══ 标签模板：增 / 删（本地存储，不消耗云函数）═══
		 * 预置模板也允许删，删除 = 写入 hiddenBuiltins（不破坏 BUILTIN_TEMPLATES 源数据） */
		loadCustomTemplates() {
			try {
				const arr = uni.getStorageSync(TPL_STORAGE_KEY)
				if (Array.isArray(arr)) this.customTemplates = arr.filter((t) => t && t.key && t.name && t.page)
				const hidden = uni.getStorageSync(TPL_HIDDEN_KEY)
				if (Array.isArray(hidden)) this.hiddenBuiltins = hidden.filter((k) => BUILTIN_TEMPLATES[k])
			} catch (e) { /* ignore */ }
		},
		saveCustomTemplates() {
			try {
				uni.setStorageSync(TPL_STORAGE_KEY, this.customTemplates)
				uni.setStorageSync(TPL_HIDDEN_KEY, this.hiddenBuiltins)
			} catch (e) { /* ignore */ }
		},
		openAddTpl() {
			this.newTpl = { name: '', w: '', h: '', fontSize: '', lineHeight: '' }
			this.$nextTick(() => this.$refs.addTplPopup && this.$refs.addTplPopup.open())
		},
		confirmAddTpl() {
			const { name, w, h, fontSize, lineHeight } = this.newTpl
			const n = (name || '').trim()
			const W = Number(w), H = Number(h)
			const FS = Number(fontSize || 11), LH = Number(lineHeight || 1.5)
			if (!n) return uni.showToast({ title: '请输入模板名', icon: 'none' })
			if (!W || W <= 0) return uni.showToast({ title: '宽度需 > 0', icon: 'none' })
			if (!H || H <= 0) return uni.showToast({ title: '高度需 > 0', icon: 'none' })
			if (FS <= 0) return uni.showToast({ title: '字号需 > 0', icon: 'none' })
			if (LH <= 0) return uni.showToast({ title: '行距需 > 0', icon: 'none' })
			const key = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
			this.customTemplates.push({
				key, name: n,
				size: `${W}×${H}mm`,
				page: { w: `${W}mm`, h: `${H}mm` },
				fontSize: FS, lineHeight: LH,
				builtin: false,
			})
			this.saveCustomTemplates()
			this.template = key              // 立即选中新模板
			this.$refs.addTplPopup && this.$refs.addTplPopup.close()
			uni.showToast({ title: '已添加', icon: 'success' })
		},
		removeTpl(tpl) {
			uni.showModal({
				title: '删除模板',
				content: `确认删除「${tpl.name}」？${tpl.builtin ? '\n（预置模板仅在本设备隐藏，不影响其他用户）' : ''}`,
				success: (m) => {
					if (!m.confirm) return
					if (tpl.builtin) {
						if (!this.hiddenBuiltins.includes(tpl.key)) this.hiddenBuiltins.push(tpl.key)
					} else {
						this.customTemplates = this.customTemplates.filter((t) => t.key !== tpl.key)
					}
					// 删的是当前选中 → 切到第一个剩余模板
					if (this.template === tpl.key) {
						const first = this.templates.find((t) => t.key !== tpl.key)
						this.template = first ? first.key : ''
					}
					this.saveCustomTemplates()
				},
			})
		},
		resetSelection() { this.selectedColors = {} },
		doPrint() {
			if (!this.labelSheets.length) {
				uni.showToast({ title: '请先选择品名', icon: 'none' })
				return
			}
			// #ifdef H5
			this.printViaIframe()
			// #endif
			// #ifndef H5
			uni.showModal({
				title: '提示',
				content: '当前为非 H5 环境，请前往电脑端管理后台操作打印',
				showCancel: false,
			})
			// #endif
		},
		/* HTML 转义，防品名/颜色名里的 < > & " 破坏打印文档结构 */
		escapeHtml(str) {
			return String(str == null ? '' : str)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
		},
		/* 把标签页渲染成独立 HTML 文档字符串（与屏幕预览共用同一套字段与样式配置） */
		buildPrintHtml() {
			const tpl = this.currentTpl
			const st = this.labelStyle
			const fs = this.effFontSize
			const attrs = this.attrItems
			const esc = (v) => this.escapeHtml(v)
			/* 由配置派生的样式片段 */
			const pageCls = st.showBorder ? ' pc-bordered' : ''
			/* 行距：未手动设置时用默认值 1.5mm；列间距固定 3mm */
			const rowGap = st.rowGap >= 0 ? st.rowGap : 1.5
			const listExtra = `flex-direction:row;flex-wrap:wrap;align-content:flex-start;gap:${rowGap}mm 3mm`

			const rows = this.labelSheets.map((s) => {
				/* 颜色项：序号 + 颜色名 */
				const colorsHtml = s.colors.map((c) => {
					const num = this.printFields.idx ? `<span class="lbl-num">${c.idx}${this.idxSep}</span>` : ''
					return `<span class="lbl-row">${num}<span class="lbl-color">${esc(c.name)}</span></span>`
				}).join('')

				/* 表头：品名（字号可单独设置，未设置时跟随正文字号）+ head 字段（编号） */
				const nameFs = st.nameSize > 0 ? st.nameSize : fs
				const headHtml = st.showHeader
					? `<div class="lbl-head"><span class="lbl-name" style="font-size:${nameFs}px">${esc(s.fabricName)}</span>${
						this.headItems.map((h) => `<span class="lbl-head-extra" style="font-size:${nameFs}px">${esc(h.value)}</span>`).join('')
					}</div>`
					: ''

				/* 中间属性行（兼容：position 不填的字段，目前无） */
				const attrHtml = attrs.length
					? `<div class="lbl-attrs">${attrs.map((a) =>
						`<span class="lbl-attr"><span class="lbl-attr-k">${esc(a.label)}</span><span class="lbl-attr-v">${esc(a.value)}</span></span>`
					).join('')}</div>`
					: ''

				/* 底部属性行：门幅 / 克重（贴底） */
				const footerHtml = this.footerItems.length
					? `<div class="lbl-attrs-foot">${this.footerItems.map((a) =>
						`<span class="lbl-attr"><span class="lbl-attr-k">${esc(a.label)}</span><span class="lbl-attr-v">${esc(a.value)}</span></span>`
					).join('')}</div>`
					: ''

				const ruleHtml = st.showDivider ? '<div class="lbl-rule"></div>' : ''

				return `<div class="print-page${pageCls}" style="width:${tpl.page.w};height:${tpl.page.h};font-size:${fs}px;line-height:${tpl.lineHeight}">${headHtml}${attrHtml}${ruleHtml}<div class="lbl-list">${colorsHtml}</div>${footerHtml}</div>`
			}).join('')

			return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
				*{box-sizing:border-box;margin:0;padding:0}
				/* 声明纸张尺寸 = 标签模板尺寸：Chrome/Edge 预览会按此分页，
				 * "另存为 PDF"直接得到正确纸型；物理打印时若驱动有同尺寸纸张会自动选中 */
				@page{margin:0;size:${tpl.page.w} ${tpl.page.h}}
				html,body{margin:0;padding:0;background:#fff}
				.print-page{display:flex;flex-direction:column;padding:2mm 4mm;overflow:hidden;background:#fff;page-break-after:always;break-after:page;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
				.print-page:last-child{page-break-after:auto;break-after:auto}
				.lbl-head{display:flex;align-items:center;justify-content:space-between;font-weight:700;color:#1d2129}
				.lbl-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
				.lbl-head-extra{flex-shrink:0;margin-left:2mm;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:35%}
				.lbl-attrs{display:flex;flex-wrap:wrap;gap:0.5mm 3mm;color:#4e5969;margin-top:0.8mm}
				.lbl-attrs-foot{display:flex;flex-wrap:wrap;gap:0.5mm 3mm;color:#4e5969;margin-top:auto;padding-top:1mm;border-top:0.3mm dashed #e5e6eb}
				.lbl-attr{white-space:nowrap}
				.lbl-attr-k{color:#86909c;margin-right:0.5mm}
				.lbl-rule{border-top:1px dashed #c9cdd4;margin:1mm 0}
				.lbl-list{flex:1;display:flex;overflow:hidden;${listExtra}}
				.pc-bordered{border:0.5mm solid #1d2129}
				.lbl-row{display:inline-flex;align-items:baseline;white-space:nowrap}
				.lbl-num{font-family:'SF Mono',Consolas,monospace;color:#4e5969;flex-shrink:0}
				.lbl-color{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
				.print-page,.print-page *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
			</style></head><body>${rows}</body></html>`
		},
		/* 独立 iframe 打印：彻底脱离当前页面 DOM，打印预览只含标签纸 */
		printViaIframe() {
			const html = this.buildPrintHtml()
			const iframe = document.createElement('iframe')
			iframe.setAttribute('style', 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;')
			document.body.appendChild(iframe)
			const doc = iframe.contentDocument || iframe.contentWindow.document
			doc.open()
			doc.write(html)
			doc.close()
			// 等 iframe 内容与字体渲染完成后再调起打印
			setTimeout(() => {
				iframe.contentWindow.focus()
				iframe.contentWindow.print()
				// 打印对话框关闭后移除 iframe
				setTimeout(() => {
					if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
				}, 1000)
			}, 300)
		},
	},
}
</script>

<style lang="scss" scoped>
/* ═══════════ 屏幕态（管理 UI）═══════════ */
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
.page-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 0 4px 16px;
	flex-shrink: 0;
}
.page-desc { font-size: 13px; color: #86909c; }
.page-desc-tip { color: #2979ff; margin-left: 6px; }
.page-header-ops { display: flex; gap: 10px; flex-shrink: 0; }

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
.btn-primary:hover { background: #1a6ae8; box-shadow: 0 2px 8px rgba(41, 121, 255, 0.35); }
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
.btn-plain:hover { color: #2979ff; border-color: #2979ff; }
.btn-primary-icon { font-size: 15px; line-height: 1; }

/* 主区：双栏 */
.main {
	flex: 1;
	min-height: 0;
	display: flex;
	gap: 16px;
}
.left-pane {
	flex-shrink: 0;
	width: 380px;
	background: #fff;
	border-radius: 8px;
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.left-scroll { flex: 1; min-height: 0; padding: 4px 0 16px; }

/* ── 配置分组（可折叠） ── */
.cfg-block { border-bottom: 1px solid #f0f2f5; }
.cfg-block:last-child { border-bottom: none; }
.cfg-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 14px 20px;
	cursor: pointer;
	user-select: none;
	transition: background 0.15s ease;
}
.cfg-head:hover { background: #fafbfc; }
.cfg-title { flex: 1; font-size: 13px; font-weight: 600; color: #1d2129; }
/* 已选数量徽标 */
.cfg-badge {
	flex-shrink: 0;
	min-width: 18px;
	height: 18px;
	padding: 0 6px;
	box-sizing: border-box;
	border-radius: 9px;
	background: rgba(41, 121, 255, 0.1);
	color: #2979ff;
	font-size: 11px;
	line-height: 18px;
	text-align: center;
	font-variant-numeric: tabular-nums;
}
/* 展开箭头 */
.cfg-caret {
	width: 6px;
	height: 6px;
	margin-top: -3px;
	border-right: 1.5px solid #86909c;
	border-bottom: 1.5px solid #86909c;
	transform: rotate(45deg);
	flex-shrink: 0;
	transition: transform 0.2s ease, margin-top 0.2s ease;
}
.cfg-caret.open { margin-top: 3px; transform: rotate(-135deg); }
.cfg-body { padding: 0 20px 16px; }
.cfg-state { padding: 14px 0; text-align: center; color: #86909c; font-size: 13px; }

/* ── ① 标签模板 ── */
.tpl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tpl-card {
	padding: 10px 12px;
	border: 1px solid #e4e7ed;
	border-radius: 6px;
	background: #fff;
	cursor: pointer;
	transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.tpl-card:hover { border-color: #2979ff; }
.tpl-card.active {
	border-color: #2979ff;
	background: rgba(41, 121, 255, 0.05);
	box-shadow: 0 0 0 3px rgba(41, 121, 255, 0.08);
}
.tpl-card-top { display: flex; align-items: center; gap: 6px; }
.tpl-name {
	flex: 1;
	min-width: 0;
	font-size: 13px;
	font-weight: 500;
	color: #1d2129;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
/* 选中勾 */
.tpl-tick {
	width: 7px;
	height: 4px;
	margin-top: -2px;
	border-left: 1.5px solid #2979ff;
	border-bottom: 1.5px solid #2979ff;
	transform: rotate(-45deg);
	flex-shrink: 0;
}
.tpl-size { display: block; margin-top: 4px; font-size: 11px; color: #86909c; }

/* 删除按钮（卡片右上 ×）：默认灰、hover 红 */
.tpl-card-x {
	font-size: 16px;
	line-height: 1;
	color: #c9cdd4;
	cursor: pointer;
	padding: 0 2px;
	flex-shrink: 0;
	transition: color 0.15s ease;
	user-select: none;
}
.tpl-card-x:hover { color: #f56c6c; }

/* 添加模板卡片：虚线边、居中图标 */
.tpl-card.tpl-card-add {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 4px;
	border-style: dashed;
	border-color: #dcdfe6;
	color: #909399;
	min-height: 56px;
	cursor: pointer;
}
.tpl-card.tpl-card-add:hover {
	border-color: #2979ff;
	color: #2979ff;
}
.tpl-card-add-icon { font-size: 20px; line-height: 1; }
.tpl-card-add-text { font-size: 12px; }

/* ── 添加模板弹窗 ── */
.add-tpl-card {
	width: 360px;
	max-width: 90vw;
	background: #fff;
	border-radius: 10px;
	padding: 20px 22px 18px;
	box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
}
.add-tpl-title {
	font-size: 16px;
	font-weight: 600;
	color: #303133;
}
.add-tpl-sub {
	margin-top: 4px;
	font-size: 12px;
	color: #909399;
}
.add-tpl-form {
	margin-top: 14px;
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.add-tpl-row {
	display: flex;
	align-items: center;
	gap: 10px;
}
.add-tpl-label {
	flex-shrink: 0;
	width: 80px;
	font-size: 13px;
	color: #606266;
}
.add-tpl-input {
	flex: 1;
	height: 32px;
	padding: 0 10px;
	border: 1px solid #dcdfe6;
	border-radius: 4px;
	font-size: 13px;
	color: #303133;
	background: #fff;
}
.add-tpl-input:focus { border-color: #2979ff; outline: none; }
.add-tpl-actions {
	margin-top: 18px;
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}

/* ── ③ 打印内容（单行复选框：门幅 / 克重 / 序号 / 编号） ── */
/* 一行排布：4 个选项等宽平分整行，窄屏也不换行；无外框，只有勾选框 + 文字 */
.fd-chips {
	display: flex;
	align-items: center;
	gap: 6px;
}
.fd-chip {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 0;
	cursor: pointer;
	transition: color 0.15s ease;
}
.fd-chip:hover .fd-label { color: #1d2129; }
.fd-check {
	width: 15px;
	height: 15px;
	box-sizing: border-box;
	border: 1.5px solid #c9cdd4;
	border-radius: 4px;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	transition: background 0.15s ease, border-color 0.15s ease;
}
.fd-chip.on .fd-check { background: #2979ff; border-color: #2979ff; }
.fd-check-mark {
	width: 7px;
	height: 4px;
	margin-top: -2px;
	border-left: 1.5px solid #fff;
	border-bottom: 1.5px solid #fff;
	transform: rotate(-45deg);
}
.fd-label { font-size: 13px; color: #4e5969; white-space: nowrap; }
.fd-chip.on .fd-label { color: #2979ff; font-weight: 500; }

/* 序号符号配置行：仅勾选「序号」字段时显示（v-if） */
.fd-idx-sep {
	margin-top: 10px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 2px;
}
.fd-idx-sep-label { font-size: 13px; color: #4e5969; flex-shrink: 0; }
.fd-idx-sep-input {
	width: 64px;
	height: 26px;
	padding: 0 8px;
	border: 1px solid #dcdfe6;
	border-radius: 3px;
	font-size: 13px;
	text-align: center;
	background: #fff;
	font-family: 'SF Mono', Consolas, monospace;
}
.fd-idx-sep-input:focus { border-color: #2979ff; outline: none; }
.fd-idx-sep-tip { font-size: 11px; color: #c0c4cc; }

/* ── ④ 标签样式 ── */
.st-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 7px 0;
}
.st-label { flex-shrink: 0; font-size: 13px; color: #4e5969; }
.st-right { display: flex; align-items: center; gap: 8px; }
/* 字号步进器 */
.st-stepper {
	display: flex;
	align-items: center;
	border: 1px solid #e4e7ed;
	border-radius: 6px;
	background: #fff;
	overflow: hidden;
}
.st-btn {
	width: 26px;
	height: 26px;
	line-height: 24px;
	text-align: center;
	font-size: 15px;
	color: #4e5969;
	cursor: pointer;
	transition: background 0.15s ease, color 0.15s ease;
}
.st-btn:hover { background: #f2f5fa; color: #2979ff; }
.st-value {
	min-width: 46px;
	line-height: 26px;
	text-align: center;
	font-size: 12px;
	color: #1d2129;
	font-variant-numeric: tabular-nums;
	border-left: 1px solid #eef0f4;
	border-right: 1px solid #eef0f4;
}
.st-reset { font-size: 12px; color: #2979ff; cursor: pointer; }
.st-reset:hover { text-decoration: underline; }
/* 区块开关组 */
.st-switches {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px 12px;
	margin-top: 10px;
	padding-top: 12px;
	border-top: 1px dashed #eef0f4;
}
.sw-item {
	display: flex;
	align-items: center;
	gap: 7px;
	font-size: 13px;
	color: #4e5969;
	cursor: pointer;
	user-select: none;
}
.sw-item.on { color: #1d2129; }
.sw-box {
	width: 15px;
	height: 15px;
	box-sizing: border-box;
	border: 1.5px solid #c9cdd4;
	border-radius: 4px;
	display: flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	transition: background 0.15s ease, border-color 0.15s ease;
}
.sw-item.on .sw-box { background: #2979ff; border-color: #2979ff; }
.sw-mark {
	width: 7px;
	height: 4px;
	margin-top: -2px;
	border-left: 1.5px solid #fff;
	border-bottom: 1.5px solid #fff;
	transform: rotate(-45deg);
}

/* ── 品名选择器（触发按钮） ── */
.fabric-select-trigger {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 38px;
	padding: 0 12px;
	border: 1px solid #e4e7ed;
	border-radius: 6px;
	background: #fff;
	cursor: pointer;
	transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.fabric-select-trigger:hover { border-color: #c9cdd4; }
.fabric-select-trigger.open {
	border-color: #2979ff;
	box-shadow: 0 0 0 3px rgba(41, 121, 255, 0.1);
}
.fabric-select-text {
	flex: 1;
	min-width: 0;
	font-size: 13px;
	color: #1d2129;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.fabric-select-trigger.empty .fabric-select-text { color: #a8abb2; }
/* 下拉箭头：CSS 绘制，避免各端字体差异 */
.fabric-select-arrow {
	width: 6px;
	height: 6px;
	margin-top: -3px;
	border-right: 1.5px solid #86909c;
	border-bottom: 1.5px solid #86909c;
	transform: rotate(45deg);
	flex-shrink: 0;
	transition: transform 0.2s ease, border-color 0.2s ease, margin-top 0.2s ease;
}
.fabric-select-trigger.open .fabric-select-arrow {
	margin-top: 3px;
	border-color: #2979ff;
	transform: rotate(-135deg);
}

/* ── 品名下拉面板（内联：紧贴触发按钮下方，随文档流撑开） ── */
.dd-panel {
	margin-top: 8px;
	max-height: 360px;         /* 仅作上限保护；实际高度由内容决定，不压缩子元素 */
	display: flex;
	flex-direction: column;
	background: #fff;
	border: 1px solid #e5e8ef;
	border-radius: 8px;
	box-shadow: 0 4px 16px rgba(31, 45, 61, 0.08);
	overflow: hidden;
	animation: dd-drop-in 0.16s ease-out;
}
@keyframes dd-drop-in {
	from { opacity: 0; transform: translateY(-4px); }
	to { opacity: 1; transform: translateY(0); }
}
/* 搜索栏：固定在面板顶部，不随列表滚动 */
.dd-search {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border-bottom: 1px solid #f2f3f5;
	background: #fff;
	flex-shrink: 0;
}
/* 放大镜图标：纯 CSS 绘制（圆 + 手柄），跨端字体无关 */
.dd-search-icon { position: relative; width: 13px; height: 13px; flex-shrink: 0; }
.dd-search-glass {
	position: absolute;
	left: 0;
	top: 0;
	width: 10px;
	height: 10px;
	box-sizing: border-box;
	border: 1.5px solid #a8abb2;
	border-radius: 50%;
}
.dd-search-handle {
	position: absolute;
	right: 0;
	bottom: 1.5px;
	width: 4.5px;
	height: 1.5px;
	border-radius: 1px;
	background: #a8abb2;
	transform: rotate(45deg);
}
.dd-search-input {
	flex: 1;
	min-width: 0;
	height: 24px;
	padding: 0;
	font-size: 13px;
	line-height: 24px;
	color: #1d2129;
	background: transparent;
	border: none;
	outline: none;
}
.dd-search-ph { color: #a8abb2; font-size: 13px; }
/* 清空按钮：灰底圆 + CSS 叉 */
.dd-search-clear {
	position: relative;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: #e5e8ef;
	flex-shrink: 0;
	cursor: pointer;
	transition: background 0.15s ease;
}
.dd-search-clear:hover { background: #d4d9e2; }
.dd-clear-line {
	position: absolute;
	left: 4px;
	top: 7.25px;
	width: 8px;
	height: 1.5px;
	border-radius: 1px;
	background: #fff;
	transform: rotate(45deg);
}
.dd-clear-line2 { transform: rotate(-45deg); }
/* ── 选项列表 ── */
/* 列表区：显式高度上限 + 自身滚动（不依赖 flex 压缩，避免与底部统计栏重叠） */
.dd-list {
	max-height: 240px;
	overflow-y: auto;
	-webkit-overflow-scrolling: touch;
}
.dd-list::-webkit-scrollbar { width: 6px; }
.dd-list::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 3px; }
.dd-list::-webkit-scrollbar-thumb:hover { background: #c9cdd4; }
.dd-list::-webkit-scrollbar-track { background: transparent; }
.dd-option {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	cursor: pointer;
	transition: background 0.12s ease;
}
.dd-option:hover { background: #f7f8fa; }
.dd-option.checked { background: rgba(41, 121, 255, 0.06); }
/* 圆形单选框（单选题语义，区别于打印内容的复选框） */
.dd-radio {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	box-sizing: border-box;
	border: 1.5px solid #c9cdd4;
	border-radius: 50%;
	flex-shrink: 0;
	transition: background 0.15s ease, border-color 0.15s ease;
}
.dd-option.checked .dd-radio { border-color: #2979ff; }
.dd-radio-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #2979ff;
}
.dd-name {
	flex: 1;
	min-width: 0;
	font-size: 13px;
	color: #1d2129;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.dd-option.checked .dd-name { color: #2979ff; font-weight: 500; }
.dd-count {
	flex-shrink: 0;
	font-size: 12px;
	color: #86909c;
	font-variant-numeric: tabular-nums;
}
.dd-option.checked .dd-count { color: #2979ff; }
/* 无匹配 */
.dd-empty {
	padding: 28px 12px;
	text-align: center;
	font-size: 13px;
	color: #86909c;
}
/* ── 底部统计栏 ── */
.dd-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	border-top: 1px solid #f2f3f5;
	background: #fafbfc;
	flex-shrink: 0;
}
.dd-foot-text { font-size: 12px; color: #86909c; }

/* 右栏预览 */
.right-pane {
	flex: 1;
	min-width: 0;
	background: #fff;
	border-radius: 8px;
	box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.preview-header {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 20px;
	height: 44px;
	border-bottom: 1px solid #e4e7ed;
}
.preview-title { font-size: 14px; font-weight: 600; color: #1d2129; }
.preview-meta { font-size: 12px; color: #86909c; }
.preview-scroll { flex: 1; min-height: 0; background: #f5f7fa; padding: 20px; overflow-y: auto; }
.preview-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 200px;
	color: #86909c;
	font-size: 13px;
}
.preview-pages {
	display: flex;
	flex-wrap: wrap;
	gap: 16px;
	justify-content: flex-start;
	align-content: flex-start;
}
.preview-page {
	background: #fff;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	padding: 2mm 4mm;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	flex-shrink: 0;
	/* 与打印 .print-page 的 *{box-sizing:border-box} 对齐：height 按总高（含 padding）计算，
	 * 否则预览内容区比打印多 8mm，实测行数偏大 → 每张多塞行 → 打印时最后几行被 overflow:hidden 裁掉 */
	box-sizing: border-box;
}

/* ═══════════ 标签内容样式（屏幕 + 打印共用）═══════════ */
.lbl-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-weight: 700;
	color: #1d2129;
}
.lbl-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* head 右侧字段（编号）：与品名样式保持一致（继承 .lbl-head 的 font-weight/color）；
 * 仅保留 max-width 35% 防止超长编号挤掉品名 + 省略号 */
.lbl-head-extra {
	flex-shrink: 0;
	margin-left: 2mm;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 35%;
}
/* 属性行：门幅 / 克重 / 成分 / 备注 */
.lbl-attrs {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5mm 3mm;
	margin-top: 0.8mm;
	color: #4e5969;
}
/* 底部属性行：门幅 / 克重（贴底，margin-top:auto 由 .preview-page / .print-page 的 flex 推到底） */
.lbl-attrs-foot {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5mm 3mm;
	color: #4e5969;
	margin-top: auto;
	padding-top: 1mm;
	border-top: 0.3mm dashed #e5e6eb;
}
.lbl-attr { display: inline-flex; align-items: baseline; white-space: nowrap; }
.lbl-attr-k { color: #86909c; margin-right: 0.5mm; }
.lbl-attr-v { color: #1d2129; }
.lbl-rule {
	border-top: 1px dashed #c9cdd4;
	margin: 1mm 0;
}
/* 颜色横向排列：flex-wrap 流式，chip 宽度随文字自适应，行满自动换行 */
.lbl-list {
	flex: 1;
	display: flex;
	flex-wrap: wrap;
	align-content: flex-start;
	justify-content: flex-start;
	gap: 1.5mm 3mm;
	overflow: hidden;
}
.lbl-row {
	display: inline-flex;
	align-items: baseline;
	gap: 0;
	color: #1d2129;
	white-space: nowrap;
	max-width: 100%;
}
/* 序号紧贴颜色名：等宽数字，不再预留对齐宽度 */
.lbl-num {
	font-family: 'SF Mono', 'SFMono-Regular', Consolas, monospace;
	font-variant-numeric: tabular-nums;
	color: #4e5969;
	flex-shrink: 0;
}
.lbl-color { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 标签样式选项（与打印 HTML 的 pg-* 保持同一套逻辑） ── */
.pg-bordered { border: 0.5mm solid #1d2129; }
</style>
