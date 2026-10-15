'use strict'

/* ════════════════════════════════════════════════════════════════
 * 统一鉴权与返回结构（公共模块，云对象共用）
 *
 *   返回结构：ok(data) → { code:0, message:'ok', data }
 *             fail(message, code=-1) → { code, message }
 *
 *   鉴权：getActor(ctx)  解析当前登录用户，返回 { uid, roles, user } 或 { fail }
 *                        （无管理员时首个登录用户自动提升为 admin，兼容冷启动）
 *         checkLogin(ctx, msg?)   仅要求已登录且账号启用（不做自动提权）
 *         checkAdmin(ctx, msg?)   仅 admin
 *         checkStaff(ctx, msg?)   仓管级：admin / warehouse
 *         checkEditor(ctx, msg?)  基础资料维护：admin / salesperson(sales)
 *       以上 checkXxx 成功返回 null，失败返回 { code, message }，调用方：
 *         const denied = await checkXxx(this); if (denied) return denied
 *
 *   角色工具：isStaff / isEditor / isSalesRole / actorName
 *
 * 口径与项目现有各云对象完全一致，仅做去重收敛，调用行为不变。
 * ════════════════════════════════════════════════════════════════ */

/* ── 统一返回结构 ── */
function ok(data) {
	return { code: 0, message: 'ok', data }
}
function fail(message, code = -1) {
	return { code, message }
}

/* ── 角色判定 ── */
/* 仓管级：管理员 / 仓管 */
const isStaff = (roles) => roles.includes('admin') || roles.includes('warehouse')
/* 基础资料维护：管理员 / 营业员（历史 sales 归入营业员） */
const isEditor = (roles) => roles.includes('admin') || roles.includes('salesperson') || roles.includes('sales')
/* 普通用户角色（非仓管级，如营业员） */
const isSalesRole = (roles) => !isStaff(roles)

/* 操作人姓名快照（uni-id 优先 nickname，其次 username） */
function actorName(user) {
	return String((user && (user.nickname || user.username)) || '').trim()
}

/* ── 核心：已解析 token → 用户与角色 ──
 * promote=true 时：系统内无 admin 则把当前用户提升为 admin（冷启动兼容） */
async function actorFromToken(token, promote) {
	const uid = token && token.uid
	if (!uid) return { fail: fail('未登录') }
	const db = uniCloud.database()
	const users = db.collection('uni-id-users')
	const res = await users.where({ _id: uid }).limit(1).get()
	if (!res.data.length) return { fail: fail('用户不存在') }
	const user = res.data[0]
	if (user.status === 1) return { fail: fail('账号已停用') }
	const roles = Array.isArray(user.role) ? user.role : user.role ? [user.role] : []
	if (promote) {
		const adminCount = await users.where({ role: 'admin' }).count()
		if (adminCount.total === 0) {
			await users.doc(uid).update({ role: ['admin'] })
			roles.push('admin')
		}
	}
	return { uid, roles, user }
}

/* 云对象入口：ctx 为云对象 this（含 getClientInfo / getUniIdToken） */
async function getActor(ctx, promote = true) {
	const UniID = require('uni-id-common')
	const uniID = UniID.createInstance({ clientInfo: ctx.getClientInfo() })
	let token = null
	try {
		token = await uniID.checkToken(ctx.getUniIdToken())
	} catch (e) {
		return { fail: fail('未登录或登录已过期') }
	}
	return actorFromToken(token, promote)
}

/* ── 常用校验：成功返回 null，失败返回 { code, message } ── */

/* 仅登录（不自动提权，用于全员可读的查询） */
async function checkLogin(ctx) {
	const actor = await getActor(ctx, false)
	if (actor.fail) return actor.fail
	return null
}

/* 仅管理员 */
async function checkAdmin(ctx, message = '仅管理员可执行该操作') {
	const actor = await getActor(ctx)
	if (actor.fail) return actor.fail
	if (actor.roles.includes('admin')) return null
	return fail(message)
}

/* 仓管级（管理员 / 仓管） */
async function checkStaff(ctx, message = '无仓管权限') {
	const actor = await getActor(ctx)
	if (actor.fail) return actor.fail
	if (isStaff(actor.roles)) return null
	return fail(message)
}

/* 基础资料维护（管理员 / 营业员） */
async function checkEditor(ctx, message = '仅管理员和营业员可维护，仓管为只读') {
	const actor = await getActor(ctx)
	if (actor.fail) return actor.fail
	if (isEditor(actor.roles)) return null
	return fail(message)
}

module.exports = {
	ok,
	fail,
	getActor,
	checkLogin,
	checkAdmin,
	checkStaff,
	checkEditor,
	isStaff,
	isEditor,
	isSalesRole,
	actorName,
}
