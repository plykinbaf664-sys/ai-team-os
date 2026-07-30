import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePlanFact,
  calculateUnitEconomics,
} from "../lib/unit-economics/calculator";

const NORMAL_INPUT = {
  revenue: 300_000,
  refunds: 20_000,
  adSpend: 100_000,
  marketingCosts: 120_000,
  acquisitionCosts: 110_000,
  otherOperatingExpenses: 30_000,
  commissions: 15_000,
  costOfGoods: 50_000,
  leads: 200,
  applications: 80,
  calls: 40,
  sales: 10,
  newCustomers: 8,
};

test("calculates the complete unit economics report", () => {
  const report = calculateUnitEconomics(NORMAL_INPUT);

  assert.equal(report.netRevenue.value, 280_000);
  assert.equal(report.cpl.value, 500);
  assert.equal(report.cac.value, 13_750);
  assert.equal(report.cpo.value, 10_000);
  assert.equal(report.averageCheck.value, 30_000);
  assert.equal(report.leadToApplicationConversion.value, 40);
  assert.equal(report.applicationToCallConversion.value, 50);
  assert.equal(report.callToSaleConversion.value, 25);
  assert.equal(report.leadToSaleConversion.value, 5);
  assert.equal(report.grossProfit.value, 215_000);
  assert.equal(report.profit.value, 65_000);
  assert.ok(Math.abs((report.margin.value ?? 0) - 23.214285714285715) < 1e-10);
  assert.equal(report.roas.value, 2.8);
  assert.ok(Math.abs((report.romi.value ?? 0) - 4 / 3) < 1e-10);
});

test("reports missing inputs without inventing zero values", () => {
  const report = calculateUnitEconomics({
    revenue: 100_000,
    refunds: 0,
  });

  assert.equal(report.netRevenue.value, 100_000);
  assert.equal(report.cpl.status, "missing_input");
  assert.deepEqual(report.cpl.missingInputs, ["adSpend", "leads"]);
  assert.equal(report.profit.status, "missing_input");
  assert.ok(report.profit.missingInputs.includes("commissions"));
  assert.equal(report.leadToSaleConversion.status, "missing_input");
});

test("returns zero denominator statuses instead of Infinity or NaN", () => {
  const report = calculateUnitEconomics({
    ...NORMAL_INPUT,
    adSpend: 0,
    marketingCosts: 0,
    acquisitionCosts: 0,
    leads: 0,
    applications: 0,
    calls: 0,
    sales: 0,
    newCustomers: 0,
  });

  assert.equal(report.cpl.status, "zero_denominator");
  assert.equal(report.cac.status, "zero_denominator");
  assert.equal(report.cpo.status, "zero_denominator");
  assert.equal(report.averageCheck.status, "zero_denominator");
  assert.equal(report.leadToApplicationConversion.status, "zero_denominator");
  assert.equal(report.applicationToCallConversion.status, "zero_denominator");
  assert.equal(report.callToSaleConversion.status, "zero_denominator");
  assert.equal(report.leadToSaleConversion.status, "zero_denominator");
  assert.equal(report.roas.status, "zero_denominator");
  assert.equal(report.romi.status, "zero_denominator");
});

test("deducts refunds, commissions and cost of goods exactly once", () => {
  const report = calculateUnitEconomics({
    revenue: 100_000,
    refunds: 10_000,
    commissions: 5_000,
    costOfGoods: 20_000,
    marketingCosts: 10_000,
    otherOperatingExpenses: 5_000,
  });

  assert.equal(report.netRevenue.value, 90_000);
  assert.equal(report.grossProfit.value, 65_000);
  assert.equal(report.profit.value, 50_000);
  assert.ok(Math.abs((report.margin.value ?? 0) - 55.55555555555556) < 1e-10);
});

test("falls back to ad spend when broader cost fields are absent", () => {
  const report = calculateUnitEconomics({
    ...NORMAL_INPUT,
    marketingCosts: undefined,
    acquisitionCosts: undefined,
  });

  assert.equal(report.cac.value, 12_500);
  assert.equal(report.profit.value, 85_000);
  assert.equal(report.romi.value, 1.8);
});

test("calculates plan-fact and handles missing or zero plans", () => {
  const results = calculatePlanFact([
    { metric: "Выручка", plan: 100_000, actual: 120_000 },
    { metric: "Продажи", plan: 0, actual: 3 },
    { metric: "Лиды", plan: 100, actual: null },
  ]);

  assert.deepEqual(results[0], {
    metric: "Выручка",
    plan: 100_000,
    actual: 120_000,
    absoluteVariance: 20_000,
    variancePercent: 20,
    completionPercent: 120,
    status: "calculated",
  });
  assert.equal(results[1].status, "zero_plan");
  assert.equal(results[1].absoluteVariance, 3);
  assert.equal(results[1].variancePercent, null);
  assert.equal(results[2].status, "missing_input");
});

test("rejects invalid financial input", () => {
  assert.throws(
    () => calculateUnitEconomics({ revenue: Number.NaN }),
    /finite number/,
  );
  assert.throws(
    () => calculateUnitEconomics({ refunds: -1 }),
    /cannot be negative/,
  );
});
