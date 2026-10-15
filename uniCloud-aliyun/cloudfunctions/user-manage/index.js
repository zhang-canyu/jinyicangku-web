'use strict'
const crypto = require('crypto')
const db = uniCloud.database()
const userCol = db.collection('uni-id-users')

// 读取 uni-id 配置（uni-config-center 公共模块）
let uniIDConfig = null
try {
	const configCenter = require('uni-config-center')
	uniIDConfig = configCenter({ pluginId: 'uni-id' }).config()
} catch (e) {
	uniIDConfig = null
}

const fail = (message, code = -1) => ({ code, message })
const ok = (data) => ({ code: 0, message: 'ok', data })

const fmtDate = (t) => {
	if (!t) return ''
	const d = new Date(t)
	const p = (n) => (n < 10 ? '0' + n : '' + n)
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* 角色收敛为三态：admin（管理员）/ warehouse（仓管）/ salesperson（营业员）
   历史 sales（业务员）已合并为 salesperson：读写均归一，防止存量账号悬空 */
const ROLE_KEYS = ['admin', 'warehouse', 'salesperson']
const normalizeRole = (role) => (role === 'sales' ? 'salesperson' : role)
const validRole = (role) => ROLE_KEYS.includes(role)

/* 标准化输出：对齐前端 AppUser 结构 */
const toView = (row) => {
	const role = Array.isArray(row.role) ? row.role[0] : row.role
	return {
		id: row._id,
		username: row.username || '',
		name: row.nickname || row.username || '未命名',
		phone: row.mobile || '',
		role: role ? normalizeRole(role) : 'salesperson',
		status: row.status === 1 ? 'inactive' : 'active',
		lastLogin: fmtDate(row.last_login_date),
		remark: row.comment || '',
	}
}

/* 权限校验：调用者须为启用状态的管理员；系统中无管理员时首个登录用户自动成为管理员 */
async function checkAdmin(event, context) {
	const UniID = require('uni-id-common')
	const uniID = UniID.createInstance({ context })
	let token = null
	try {
		token = await uniID.checkToken(event.uniIdToken)
	} catch (e) {
		return fail('未登录或登录已过期')
	}
	const uid = token && token.uid
	if (!uid) return fail('未登录')
	const res = await userCol.where({ _id: uid }).limit(1).get()
	if (!res.data.length) return fail('用户不存在')
	const user = res.data[0]
	if (user.status === 1) return fail('账号已停用')
	const roles = Array.isArray(user.role) ? user.role : user.role ? [user.role] : []
	if (roles.includes('admin')) return null
	// 无管理员时，将首个登录用户提升为管理员（初始化）
	const adminCount = await userCol.where({ role: 'admin' }).count()
	if (adminCount.total === 0) {
		await userCol.doc(uid).update({ role: ['admin'] })
		return null
	}
	return fail('无管理员权限')
}

/* 用户列表（分页 + 关键字搜索） */
async function list(event) {
	const { keyword = '', page = 1, pageSize = 50 } = event
	let where = {}
	if (keyword) {
		const reg = new RegExp(keyword)
		where = db.command.or([{ nickname: reg }, { username: reg }, { mobile: reg }])
	}
	const countRes = await userCol.where(where).count()
	const res = await userCol
		.where(where)
		.field({ _id: true, username: true, nickname: true, mobile: true, role: true, status: true, register_date: true, last_login_date: true, comment: true })
		.orderBy('register_date', 'desc')
		.skip((page - 1) * pageSize)
		.limit(pageSize)
		.get()
	return ok({ list: res.data.map(toView), total: countRes.total })
}

/* 用户详情 */
async function get(event) {
	const { id } = event
	if (!id) return fail('缺少用户id')
	const res = await userCol
		.doc(id)
		.field({ _id: true, username: true, nickname: true, mobile: true, role: true, status: true, register_date: true, last_login_date: true, comment: true })
		.get()
	if (!res.data.length) return fail('用户不存在')
	return ok(toView(res.data[0]))
}

/* 新增用户（不设密码，通过微信/手机号登录） */
async function add(event) {
	const { name, phone, role, remark } = event
	if (!name || !name.trim()) return fail('请填写用户姓名')
	const r = role ? normalizeRole(String(role)) : 'salesperson'
	if (!validRole(r)) return fail('无效的角色')
	const mobile = (phone || '').trim()
	const data = {
		username: 'u' + Date.now(),
		nickname: name.trim(),
		mobile,
		// 管理后台录入的手机号视为已验证，否则 uni-id-co 手机号密码登录会查不到该用户
		mobile_confirmed: mobile ? 1 : 0,
		role: [r],
		status: 0,
		comment: (remark || '').trim(),
		register_date: Date.now(),
		register_env: 'manage',
	}
	const dup = await userCol
		.where({ $or: [{ username: data.username }, ...(data.mobile ? [{ mobile: data.mobile }] : [])] })
		.limit(1)
		.get()
	if (dup.data.length) return fail('用户名或手机号已存在', 500)
	const addRes = await userCol.add(data)
	return ok({ id: addRes.id })
}

/* 更新用户（昵称/手机号/角色/状态/备注）
   状态变更保护：禁止停用自己、禁止停用最后一个启用的管理员，
   避免管理功能被锁死后无法再启用 */
async function update(event, context) {
	const { id, name, phone, role, status, remark } = event
	if (!id) return fail('缺少用户id')

	/* 解析当前登录用户 */
	let uid = ''
	try {
		const UniID = require('uni-id-common')
		const uniID = UniID.createInstance({ context })
		const token = await uniID.checkToken(event.uniIdToken)
		uid = token && token.uid
	} catch (e) {}

	/* 停用保护 */
	if (status !== undefined && status === 'inactive') {
		if (id === uid) return fail('不能停用当前登录用户')
		/* 目标为管理员时，停用后必须至少保留一个启用的管理员 */
		const target = await userCol.doc(id).field({ role: true }).get()
		if (target.data.length) {
			const targetRole = Array.isArray(target.data[0].role)
				? target.data[0].role
				: target.data[0].role ? [target.data[0].role] : []
			if (targetRole.includes('admin')) {
				const adminCount = await userCol.where({ role: 'admin', status: 0 }).count()
				if (adminCount.total <= 1) return fail('至少保留一个启用的管理员')
			}
		}
	}

	/* 手机号唯一性校验（排除自身） */
	if (phone !== undefined && (phone || '').trim()) {
		const mobile = (phone || '').trim()
		const dup = await userCol.where({ mobile, _id: db.command.neq(id) }).limit(1).get()
		if (dup.data.length) return fail('该手机号已被其他用户使用')
	}

	const data = {}
	if (name !== undefined) data.nickname = (name || '').trim()
	if (phone !== undefined) {
		data.mobile = (phone || '').trim()
		// 管理后台修改手机号视为已验证，保证手机号+密码登录可用
		data.mobile_confirmed = data.mobile ? 1 : 0
	}
	if (role !== undefined) {
		const r = role ? normalizeRole(String(role)) : ''
		if (r && !validRole(r)) return fail('无效的角色')
		data.role = r ? [r] : []
	}
	if (status !== undefined) data.status = status === 'inactive' ? 1 : 0
	if (remark !== undefined) data.comment = (remark || '').trim()
	const res = await userCol.doc(id).update(data)
	if (!res.updated) return fail('用户不存在或未变更')
	return ok({ id })
}

/* 重置密码（与 uni-id-co 加密算法一致：hmac-sha256 + 随机盐，格式 $UNI_ID_HMAC_SHA256$20$<salt><hash>） */
async function resetPwd(event) {
	const { id, password } = event
	if (!id) return fail('缺少用户id')
	if (!password || password.length < 6) return fail('密码长度不能少于6位')
	const pwdSecretList = (uniIDConfig && uniIDConfig.passwordSecret) || []
	if (!pwdSecretList.length) return fail('uni-id 密码密钥未配置，请在 uni-id/config.json 的 passwordSecret 中配置', 500)
	// 与 uni-id-co lib/utils/password.js 的 UNI_ID_HMAC_SHA256 加密逻辑保持一致
	const salt = crypto.randomBytes(10).toString('hex')
	const sha256Hash = crypto.createHmac('sha256', salt).update(password).digest('hex')
	const passwordHash = `$UNI_ID_HMAC_SHA256$${salt.length}$${salt}${sha256Hash}`
	const secretVersion = (pwdSecretList[0] && pwdSecretList[0].version) || 0
	await userCol.doc(id).update({
		password: passwordHash,
		password_secret_version: secretVersion,
		valid_token: [],
	})
	return ok({ id })
}

/* 删除用户（禁止删除自己） */
async function remove(event, context) {
	const { id } = event
	if (!id) return fail('缺少用户id')
	const UniID = require('uni-id-common')
	const uniID = UniID.createInstance({ context })
	let token = null
	try {
		token = await uniID.checkToken(event.uniIdToken)
	} catch (e) {
		return fail('未登录或登录已过期')
	}
	const uid = token && token.uid
	if (id === uid) return fail('不能删除当前登录用户')
	await userCol.doc(id).remove()
	return ok({ id })
}

/* ════════════════════════════════════════════════════════════════
 * 数据清空（原 data-manage 云对象并入，统一走 user-manage）
 *   前端调用方：common/api/data.js → dataApi.clear(scope)
 *   scope: orders  → 清空订单（order / order_item / 旧表 outbound_order）
 *          inbound → 清空出入库记录与库存（inbound_order 入库单 +
 *                    order / order_item / outbound_order 出库单 +
 *                    stock_roll / stocktake_location；不含库位设置
 *                    location / location_zone）
 *   安全：main 已统一校验管理员，仅 admin 可执行；清空不可逆
 * ════════════════════════════════════════════════════════════════ */
const SCOPE_TABLES = {
	orders: ['order', 'order_item', 'outbound_order'],
	/* 清空出入库记录：入库单 + 出库单（order 主从表 / 旧表 outbound_order）+ 库存，保留库位设置 */
	inbound: [
		'inbound_order', 'order', 'order_item', 'outbound_order',
		'stock_roll', 'stocktake_location',
	],
	/* all（重置所有数据）已暂时下线 */
}

/* 清空单个集合：分批删除（uniCloud remove 单次上限 100 条），返回删除条数 */
async function clearTable(name) {
	const cmd = db.command
	const col = db.collection(name)
	let total = 0
	try {
		for (;;) {
			const res = await col.where({ _id: cmd.exists(true) }).limit(100).field({ _id: true }).get()
			if (!res.data.length) break
			const ids = res.data.map((d) => d._id)
			await col.where({ _id: cmd.in(ids) }).remove()
			total += ids.length
		}
	} catch (e) {
		// 集合不存在等异常忽略，按 0 条处理
	}
	return total
}

/* 清空数据：clear({ scope }) → { [集合名]: 删除条数 } */
async function clearData(event) {
	const scope = String(event.scope || '')
	const tables = SCOPE_TABLES[scope]
	if (!tables) return fail('无效的清空范围')
	const result = {}
	for (const name of tables) {
		result[name] = await clearTable(name)
	}
	return ok(result)
}

exports.main = async (event, context) => {
	const { action } = event
	if (!action) return fail('缺少action')
	const denied = await checkAdmin(event, context)
	if (denied) return denied
	switch (action) {
		case 'list':
			return list(event)
		case 'get':
			return get(event)
		case 'add':
			return add(event)
		case 'update':
			return update(event, context)
		case 'resetPwd':
			return resetPwd(event)
		case 'remove':
			return remove(event, context)
		case 'clear':
			return clearData(event)
		default:
			return fail('未知action: ' + action)
	}
}
