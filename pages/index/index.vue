<template>
	<view class="fix-top-window">
		<view class="uni-header">
			<!-- 统计面包屑 -->
			<uni-stat-breadcrumb class="uni-stat-breadcrumb-on-phone" />
			<view class="uni-group">
				<view class="uni-sub-title hide-on-phone"></view>
			</view>
		</view>
		<view class="uni-container">
			<!-- 提示条1：初始化db_init.json -->
			<uni-notice-bar v-if="showdbInit" showGetMore showIcon class="mb-m pointer" text="检测到您未初始化db_init.json，请先右键uniCloud/database/db_init.json文件，执行初始化云数据库，否则左侧无法显示菜单等数据" background-color="#fef0f0" color="#f56c6c" @click="toAddAppId" />
			<!-- 提示条2：添加应用 -->
			<uni-notice-bar v-if="showAddAppId" showGetMore showIcon class="mb-m pointer" text="检测到您还未添加应用，点击前往应用管理添加" @click="toAddAppId" />
			<!-- 近 30 天每日出库条数曲线（云端按东八区「已发货」时间归日统计出货条数） -->
			<view class="uni-stat--x p-m mb-m">
				<view class="uni-stat-card-header">
					<text>近 30 天出库条数</text>
					<text v-if="!outChartLoading && !outChartError" class="out-chart-total">合计 {{ outTotal }} 条</text>
				</view>
				<view class="out-chart-box">
					<text v-if="outChartLoading" class="out-chart-tip">加载中…</text>
					<text v-else-if="outChartError" class="out-chart-tip out-chart-tip-err">{{ outChartError }}</text>
					<text v-else-if="!outTotal" class="out-chart-tip">近 30 天暂无出库记录</text>
					<qiun-data-charts v-else type="line" :chartData="outChartData" :opts="outChartOpts"
						:errorMessage="outChartError" />
				</view>
			</view>

			<!-- 排名区：客户（左）/ 产品（右）并排，两者口径一致，各自独立加载与降级 -->
			<view class="rank-row mb-m">
				<view class="uni-stat--x p-m rank-col">
					<view class="uni-stat-card-header">
						<text>近 30 天客户出货排名</text>
						<text v-if="!custChartLoading && !custChartError && custList.length" class="out-chart-total">
							Top {{ custList.length }} · {{ custTotal }} 条
						</text>
					</view>
					<view class="cust-chart-box">
						<text v-if="custChartLoading" class="out-chart-tip">加载中…</text>
						<text v-else-if="custChartError" class="out-chart-tip out-chart-tip-err">{{ custChartError }}</text>
						<text v-else-if="!custList.length" class="out-chart-tip">近 30 天暂无客户出货记录</text>
						<qiun-data-charts v-else type="column" :chartData="custChartData" :opts="custChartOpts"
							:errorMessage="custChartError" />
					</view>
				</view>

				<view class="uni-stat--x p-m rank-col">
					<view class="uni-stat-card-header">
						<text>近 30 天产品出库排名</text>
						<text v-if="!prodChartLoading && !prodChartError && prodList.length" class="out-chart-total">
							Top {{ prodList.length }} · {{ prodTotal }} 条
						</text>
					</view>
					<view class="cust-chart-box">
						<text v-if="prodChartLoading" class="out-chart-tip">加载中…</text>
						<text v-else-if="prodChartError" class="out-chart-tip out-chart-tip-err">{{ prodChartError }}</text>
						<text v-else-if="!prodList.length" class="out-chart-tip">近 30 天暂无产品出库记录</text>
						<qiun-data-charts v-else type="column" :chartData="prodChartData" :opts="prodChartOpts"
							:errorMessage="prodChartError" />
					</view>
				</view>
			</view>
		</view>

		<!-- #ifndef H5 -->
		<fix-window />
		<!-- #endif -->
	</view>
</template>

<script>
	/* 出库云对象：customUI 让错误由调用方处理（首页失败时降级为文案提示，不弹 toast 打断统计加载） */
	const outboundCo = uniCloud.importObject('outbound-manage', { customUI: true })

	/* 柱顶名称截断：超过 6 字取前 5 字 + 省略号
	 * 两个排名图并排后每栏只剩半宽，名称不打招呼会与邻柱文字重叠 */
	function shortName(n) {
		const s = String(n || '')
		return s.length > 6 ? `${s.slice(0, 5)}…` : s
	}

	export default {
		data() {
			return {
				showAddAppId: false,
				showdbInit: false,
				/* 近 30 天出库条数曲线 */
				outChartLoading: false,
				outChartError: '',
				outTotal: 0,
				outChartData: { categories: [], series: [] },
				outChartOpts: {
					color: ['#2979ff'],
					padding: [15, 15, 10, 5],
					enableScroll: false,
					legend: { show: false },
					/* labelCount：30 个日期标签全显示会重叠，强制稀疏成 ~10 个（自动隔位采样） */
					xAxis: { disableGrid: true, fontSize: 11, lineHeight: 20, fontColor: '#909399', labelCount: 10 },
					yAxis: { gridType: 'dash', dashLength: 4, data: [{ min: 0 }] },
					extra: { line: { type: 'curve', width: 2, activeType: 'hollow' } },
				},
				/* 近 30 天客户出货量排名 */
				custChartLoading: false,
				custChartError: '',
				custList: [],
				custTotal: 0,
				custChartData: { categories: [], series: [] },
				custChartOpts: {
					color: ['#2979ff'],
					padding: [15, 15, 10, 5],
					enableScroll: false,
					legend: { show: false },
					/* 名称改由 series.formatter 直接标在柱顶，X 轴不再重复显示名称 */
					xAxis: { disabled: true, disableGrid: true },
					yAxis: { gridType: 'dash', dashLength: 4, data: [{ min: 0 }], fontSize: 11, fontColor: '#909399' },
					/* 注意：type="column" 时必须配 extra.column（源码取 opts.extra.column.labelPosition），
					 * 沿用 extra.bar 会因读取 undefined 属性而报错 */
					extra: { column: { type: 'group', width: 18, activeBgColor: '#000000', activeBgOpacity: 0.08 } },
				},
				/* 近 30 天产品出库排名（与上面客户排名同款配置，各自独立一份避免图表实例互相干扰） */
				prodChartLoading: false,
				prodChartError: '',
				prodList: [],
				prodTotal: 0,
				prodChartData: { categories: [], series: [] },
				prodChartOpts: {
					color: ['#67c23a'],
					padding: [15, 15, 10, 5],
					enableScroll: false,
					legend: { show: false },
					xAxis: { disabled: true, disableGrid: true },
					yAxis: { gridType: 'dash', dashLength: 4, data: [{ min: 0 }], fontSize: 11, fontColor: '#909399' },
					extra: { column: { type: 'group', width: 18, activeBgColor: '#000000', activeBgOpacity: 0.08 } },
				},
			}
		},
		onReady() {
			// 检查appId
			this.checkAppId();

			this.checkdbInit();

			// 近 30 天出库条数曲线
			this.loadOutChart();

			// 近 30 天客户出货量排名
			this.loadCustChart();

			// 近 30 天产品出库排名
			this.loadProdChart();
		},

		methods: {
			/* 近 30 天每日出库条数：口径与报表条数列一致
			 * （source≠sample + 已发货；打样单 count 是剪样段数，不计入条数）
			 * 加载失败只降级为卡片内文案提示，不影响页面其他模块 */
			async loadOutChart() {
				this.outChartLoading = true
				this.outChartError = ''
				try {
					const res = await outboundCo.dailyOutCount({ days: 30 })
					// 云端 ok() 返回 { code, message, data }，列表在 res.data.list（不是 res.list）
					const list = (res && res.code === 0 && res.data && res.data.list) || []
					this.outTotal = list.reduce((s, d) => s + (d.count || 0), 0)
					this.outChartData = {
						categories: list.map((d) => d.label),
						series: [{ name: '出库条数', data: list.map((d) => d.count || 0) }],
					}
				} catch (e) {
					this.outChartError = (e && e.message) || '加载失败'
				} finally {
					this.outChartLoading = false
				}
				},

				/* 近 30 天客户出货量排名：口径与上方曲线一致（source≠sample + 已发货，打样单不计条数）
				* 云端已按条数降序取前 N 名，前端只负责渲染；加载失败降级为卡片内文案提示 */
				async loadCustChart() {
				this.custChartLoading = true
				this.custChartError = ''
				try {
					const res = await outboundCo.topCustomerOut({ days: 30, limit: 10 })
					// 云端 ok() 返回 { code, message, data }，列表在 res.data.list
					const list = (res && res.code === 0 && res.data && res.data.list) || []
					this.custList = list
					this.custTotal = list.reduce((s, d) => s + (d.count || 0), 0)
					this.custChartData = {
						categories: list.map((d) => d.customer),
						series: [{
							name: '出货条数',
							data: list.map((d) => d.count || 0),
							/* 柱顶标名称、tooltip 显示数值：uCharts 两处调用本 formatter，传参个数不同
							 *   柱顶绘制 drawColumePointText → formatter(value, index, series, opts) 有 index → 返回名称
							 *   tooltip 取数 getSeriesDataItem → item.formatter(value) 无 index → 返回数值
							 * 靠 index 是否传入区分（tooltip 只传一个参数，index 为 undefined） */
							formatter: (val, index) => (index === undefined ? val : shortName(list[index] && list[index].customer)),
							textSize: 10,
							textColor: '#606266',
						}],
					}
				} catch (e) {
					this.custChartError = (e && e.message) || '加载失败'
				} finally {
					this.custChartLoading = false
				}
				},

				/* 近 30 天产品（品名）出库排名：口径同上（source≠sample + 已发货，打样单不计条数）
				* 品名只在明细表，云端已两步联表聚合好并按条数降序取前 N 名 */
				async loadProdChart() {
				this.prodChartLoading = true
				this.prodChartError = ''
				try {
					const res = await outboundCo.topProductOut({ days: 30, limit: 10 })
					const list = (res && res.code === 0 && res.data && res.data.list) || []
					this.prodList = list
					this.prodTotal = list.reduce((s, d) => s + (d.count || 0), 0)
					this.prodChartData = {
						categories: list.map((d) => d.product),
						series: [{
							name: '出库条数',
							data: list.map((d) => d.count || 0),
							/* 柱顶标名称、tooltip 显示数值（调用约定同上） */
							formatter: (val, index) => (index === undefined ? val : shortName(list[index] && list[index].product)),
							textSize: 10,
							textColor: '#606266',
						}],
					}
				} catch (e) {
					this.prodChartError = (e && e.message) || '加载失败'
				} finally {
					this.prodChartLoading = false
				}
				},

				toUrl(url) {
				// #ifdef H5
				// 在新窗口中打开url链接（仅适用于H5平台）
				window.open(url, "_blank");
				// #endif
			},

			toAddAppId() {
				// 隐藏添加App ID的标识
				this.showAddAppId = false;
				// 使用uni.navigateTo方法进行页面跳转到指定路径
				uni.navigateTo({
					url: "/pages/system/app/list",
					events: {
						// 注册事件，用于在目标页面刷新数据后执行回调
						refreshData: () => {
							this.checkAppId();
						}
					}
				});
			},

			async checkAppId() {
				// 获取uniCloud数据库的实例
				const db = uniCloud.database();
				// 查询'opendb-app-list'集合的数据数量
				let res = await db.collection('opendb-app-list').count();
				// 如果查询结果为空或total为0，则显示添加App ID的标识
				this.showAddAppId = (!res.result || res.result.total === 0) ? true : false;
			},

			async checkdbInit(){
				// 获取uniCloud数据库的实例
				const db = uniCloud.database();
				// 查询'opendb-app-list'集合的数据数量
				let res = await db.collection('opendb-admin-menus').count();
				// 如果查询结果为空或total为0，则显示添加App ID的标识
				this.showdbInit = (!res.result || res.result.total === 0) ? true : false;
				if (this.showdbInit) {
					uni.showModal({
						title: "重要提示",
						content: `检测到您未初始化数据库，请先右键uni-admin项目根目下的 uniCloud/database 目录，执行初始化云数据库，否则左侧无法显示菜单等数据`,
						showCancel: false,
						confirmText: "我知道了"
					});
				}
			}

		}

	}
</script>

<style>
	.uni-stat-card-header {
		display: flex;
		justify-content: space-between;
		color: #555;
		font-size: 14px;
		font-weight: 600;
		padding: 10px 0;
		margin-bottom: 15px;
	}

	/* 近 30 天出库曲线 */
	.out-chart-box {
		height: 260px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.out-chart-tip {
		font-size: 13px;
		color: #909399;
	}
	.out-chart-tip-err { color: #f56c6c; }
	.out-chart-total {
		font-size: 13px;
		font-weight: 400;
		color: #909399;
	}

	/* 排名区：客户 / 产品 左右并排；min-width:0 让 flex 子项可收缩，避免长品名撑破布局 */
	.rank-row {
		display: flex;
		gap: 15px;
	}
	.rank-col {
		flex: 1;
		min-width: 0;
	}

	/* 排名柱状图（X 轴标签倾斜，需比曲线图多留高度） */
	.cust-chart-box {
		height: 300px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.uni-table-scroll {
		min-height: auto;
	}

	.link-btn-color {
		color: #007AFF;
		cursor: pointer;
	}

	.uni-stat-text {
		color: #606266;
	}

	.mt10 {
		margin-top: 10px;
	}

	.uni-radio-cell {
		margin: 0 10px;
	}

	.uni-stat-tooltip-s {
		width: 400px;
		white-space: normal;
	}

	.uni-a {
		cursor: pointer;
		text-decoration: underline;
		color: #555;
		font-size: 14px;
	}
</style>
