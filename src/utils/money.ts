import { USDC_DECIMALS } from '../config/usdc';

export function parseUsdcDecimalToStroops(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('invalid decimal');
  }

  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`too many decimal places (max ${USDC_DECIMALS})`);
  }

  const paddedFrac = frac.padEnd(USDC_DECIMALS, '0');
  const units = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '');
  return BigInt(units);
}

export function formatUsdcStroopsToDecimal(stroops: bigint): string {
  const sign = stroops < 0n ? '-' : '';
  const abs = stroops < 0n ? -stroops : stroops;
  const s = abs.toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = s.slice(0, -USDC_DECIMALS);
  const frac = s.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return frac.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

