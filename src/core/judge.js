// core/judge.js —— 有效传输率判定（纯函数）
import { EXCLUSIONS } from '../config.js';

const effRate = (o) => (o && o.comple && o.comple.effeTransRate != null)
  ? o.comple.effeTransRate
  : (o && o.realtime ? o.realtime.effeTransRate : null);

function isExcluded(mp) {
  for (const ex of EXCLUSIONS) {
    if (mp.mpName && mp.mpName.includes(ex.name)) {
      if (ex.onlyWhenZero) {
        const rt = mp.realtime ? mp.realtime.effeTransRate : null;
        const cp = mp.comple ? mp.comple.effeTransRate : null;
        if (rt === 0 && cp === 0) return ex;
      } else {
        return ex;
      }
    }
  }
  return null;
}

// 废水监控点（2026-09-23 新增）：据《自动监测数据有效传输率统计算法说明》——
//   废水 CODCr/NH3-N/TP/TN 每日可有 1 小时因自动标样核查不参与分母统计，
//   即缺 ≤1 小时（率 ≥ 23/24 ≈ 95.83%）时官方口径已是 100%，不该报为异常。
const WASTEWATER_MPS = ['总排口'];
const WW_RATE_FLOOR = 95.83;

function isWastewaterOk(mp) {
  if (!mp || !mp.mpName) return false;
  if (!WASTEWATER_MPS.some((n) => mp.mpName.includes(n))) return false;
  const r = effRate(mp);
  return r != null && r >= WW_RATE_FLOOR;
}

function judge(data) {
  const unitRate = effRate(data);
  const underperforming = [];
  const excluded = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    if (ex) { excluded.push({ mpName: mp.mpName, reason: ex.reason }); continue; }
    const r = effRate(mp);
    if (r == null) continue;
    if (isWastewaterOk(mp)) continue; // 废水：≤1h 标样核查已被官方排除，视为达标
    if (r < 100) {
      underperforming.push({
        mpName: mp.mpName,
        realtime: mp.realtime ? mp.realtime.effeTransRate : null,
        comple: mp.comple ? mp.comple.effeTransRate : null,
        rate: r,
      });
    }
  }
  return { unitRate, isCase1: unitRate === 100 && underperforming.length === 0, underperforming, excluded };
}

export { effRate, isExcluded, isWastewaterOk, judge, WASTEWATER_MPS, WW_RATE_FLOOR };
