'use strict';
// RAM validation. The renderer's slider is only a suggestion; the main process
// decides what is acceptable using the machine's real memory.
const os = require('node:os');
const { RAM_MIN_GB, RAM_MAX_GB } = require('./settings');

const GB = 1024 ** 3;
const OS_RESERVE_GB = 1; // always leave this much for the OS

function getMemoryInfo(source = os) {
  const totalGb = source.totalmem() / GB;
  const freeGb = source.freemem() / GB;
  // Hard cap: never allocate the entire machine.
  const hardMaxGb = Math.max(1, Math.min(RAM_MAX_GB, Math.floor(totalGb - OS_RESERVE_GB)));
  return {
    totalGb: Math.round(totalGb * 10) / 10,
    freeGb: Math.round(freeGb * 10) / 10,
    minGb: Math.min(RAM_MIN_GB, hardMaxGb),
    maxGb: hardMaxGb,
    recommendedGb: Math.max(1, Math.min(4, Math.floor(hardMaxGb / 2) || 1))
  };
}

/**
 * @param {unknown} requestedGb
 * @param {ReturnType<typeof getMemoryInfo>} info
 * @param {{ javaIs64Bit?: boolean }} [opts]
 * @returns {{ ok: boolean, valueGb?: number, error?: string, warnings: string[] }}
 */
function validateRam(requestedGb, info, opts = {}) {
  const warnings = [];
  if (typeof requestedGb !== 'number' || !Number.isInteger(requestedGb)) {
    return { ok: false, error: 'Объём памяти должен быть целым числом GB.', warnings };
  }
  if (requestedGb < info.minGb) {
    return { ok: false, error: `Минимум — ${info.minGb} GB.`, warnings };
  }
  if (requestedGb > RAM_MAX_GB) {
    return { ok: false, error: `Максимум — ${RAM_MAX_GB} GB.`, warnings };
  }
  if (requestedGb > info.maxGb) {
    return {
      ok: false,
      error: `Столько памяти выделить нельзя: в системе ${info.totalGb} GB, максимум для запуска — ${info.maxGb} GB (1 GB остаётся системе).`,
      warnings
    };
  }
  if (opts.javaIs64Bit === false && requestedGb > 1) {
    return { ok: false, error: '32-разрядная Java не может использовать больше ~1 GB. Установите 64-разрядную Java.', warnings };
  }
  if (requestedGb > info.freeGb) {
    warnings.push(`Сейчас свободно ${info.freeGb} GB — система может начать использовать файл подкачки. Закройте лишние программы.`);
  }
  if (requestedGb > info.totalGb * 0.75) {
    warnings.push('Выделено больше 75% оперативной памяти — это может замедлить систему.');
  }
  return { ok: true, valueGb: requestedGb, warnings };
}

module.exports = { getMemoryInfo, validateRam, GB, OS_RESERVE_GB };
