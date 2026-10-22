// config.js —— 项目业务配置（唯一事实来源：config/project.json）
// 2026-10-22 波次1（P0）：业务常量出源码——排除点/公司名/阈值/推送窗口改这里即可。
// 2026-10-22 波次3：从 index.js 拆出，供 core/io 各模块共享。
import PROJECT_JSON from '../config/project.json' with { type: 'json' };

const PROJECT_DEFAULTS = {
  psId: '654000000031',
  companyName: '伊犁川宁生物技术股份有限公司',
  exclusions: [
    { name: '3号机组', reason: '工况标记：停运，不计入有效传输率统计时段', onlyWhenZero: true },
  ],
  thresholds: { autoMarkMinMinutes: 15, autoMarkMinPerHour: 15 },
  pushWindow: { startHour: 15, endHour: 21 },
};

const PROJECT = { ...PROJECT_DEFAULTS, ...(PROJECT_JSON || {}) };

// 启动校验：配置非法必须「响亮的失败」——由 run() 兜底写 last-result，绝不用默认值静默跑错业务。
// （模块加载阶段不抛错，保证测试与 buildText 等纯函数可正常导入。）
function validateProjectConfig() {
  const problems = [];
  if (!/^\d{10,}$/.test(String(PROJECT.psId || ''))) problems.push(`psId 非法: ${PROJECT.psId}`);
  if (typeof PROJECT.companyName !== 'string' || !PROJECT.companyName) problems.push('companyName 缺失');
  if (!Array.isArray(PROJECT.exclusions)) problems.push('exclusions 必须是数组');
  else for (const ex of PROJECT.exclusions) {
    if (!ex || typeof ex.name !== 'string' || !ex.name) problems.push(`exclusions 条目缺 name: ${JSON.stringify(ex)}`);
  }
  const t = PROJECT.thresholds || {};
  for (const k of ['autoMarkMinMinutes', 'autoMarkMinPerHour']) {
    if (!Number.isFinite(t[k]) || t[k] < 1 || t[k] > 120) problems.push(`thresholds.${k} 非法: ${t[k]}`);
  }
  const w = PROJECT.pushWindow || {};
  if (!Number.isInteger(w.startHour) || !Number.isInteger(w.endHour) || w.startHour >= w.endHour) {
    problems.push(`pushWindow 非法: ${JSON.stringify(w)}`);
  }
  if (problems.length) throw new Error(`project.json 配置非法：\n- ${problems.join('\n- ')}`);
}

const COMPANY_NAME = PROJECT.companyName;
// 不计入统计的监控点（来源：config/project.json）
const EXCLUSIONS = PROJECT.exclusions;

export { PROJECT, PROJECT_DEFAULTS, COMPANY_NAME, EXCLUSIONS, validateProjectConfig };
