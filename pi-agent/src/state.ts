/**
 * 域状态：演示用合成数据，金额一律整数分。
 * 真实系统里这一层换成行内核心/接口层，工具签名不变。
 */
export interface Card {
  id: string;
  label: string;
  status: "active" | "locked" | "lost";
  limitCents: number;
}

export interface BillCategory {
  name: string;
  cents: number;
}

export interface BillAnomaly {
  merchant: string;
  cents: number;
  reason: string;
}

export interface BankState {
  account: { holder: string; balanceCents: number; availableCents: number };
  cards: Card[];
  phone: string;
  bills: { totalCents: number; categories: BillCategory[]; anomalies: BillAnomaly[] };
  receiptSeq: number;
}

/** 演示初始状态。余额 38642.50 元，借记卡 5678，预留手机号 13900001111。 */
export function initialState(): BankState {
  return {
    account: { holder: "林知远", balanceCents: 3864250, availableCents: 3864250 },
    cards: [
      { id: "card-002", label: "借记卡 5678", status: "active", limitCents: 1000000 }
    ],
    phone: "13900001111",
    bills: {
      totalCents: 931800,
      categories: [
        { name: "数码", cents: 740700 },
        { name: "购物", cents: 67200 },
        { name: "生活缴费", cents: 65600 },
        { name: "餐饮", cents: 43300 }
      ],
      anomalies: [{ merchant: "极光数码", cents: 688000, reason: "凌晨 2 点发生大额交易" }]
    },
    receiptSeq: 1000
  };
}

/** 分 → 元，固定两位小数，不做浮点累加。 */
export function yuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return sign + String(Math.floor(abs / 100)) + "." + String(abs % 100).padStart(2, "0");
}

/** 手机号脱敏：保留前三后四。 */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return "****";
  return phone.slice(0, 3) + "****" + phone.slice(-4);
}

/** 卡号/卡标识脱敏。 */
export function maskCard(cardId: string): string {
  return cardId.length <= 4 ? "****" : "****" + cardId.slice(-4);
}

/** 日志脱敏：手机号、长卡号一律在入审计前替换。 */
export function redact(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, (value) => value.slice(0, 3) + "****" + value.slice(-4))
    .replace(/\b\d{12,19}\b/g, (value) => "****" + value.slice(-4))
    .replace(/card-\d+/g, (value) => "card-****" + value.slice(-2));
}
