import type {
  CalculatedMetric,
  MetricUnit,
  PlanFactInput,
  PlanFactResult,
  UnitEconomicsInput,
  UnitEconomicsInputField,
  UnitEconomicsReport,
} from "./types";

type MetricInputValue = {
  field: UnitEconomicsInputField;
  value: number | null | undefined;
};

export function calculateUnitEconomics(
  input: UnitEconomicsInput,
): UnitEconomicsReport {
  validateInput(input);

  const marketingExpense =
    input.marketingCosts ?? input.adSpend;
  const marketingExpenseField: UnitEconomicsInputField =
    input.marketingCosts !== null && input.marketingCosts !== undefined
      ? "marketingCosts"
      : "adSpend";
  const acquisitionExpense =
    input.acquisitionCosts ?? input.adSpend;
  const acquisitionExpenseField: UnitEconomicsInputField =
    input.acquisitionCosts !== null && input.acquisitionCosts !== undefined
      ? "acquisitionCosts"
      : "adSpend";
  const netRevenueValue =
    input.revenue !== null &&
    input.revenue !== undefined &&
    input.refunds !== null &&
    input.refunds !== undefined
      ? input.revenue - input.refunds
      : null;
  const missingNetRevenueInputs = [
    input.revenue === null || input.revenue === undefined
      ? "revenue"
      : null,
    input.refunds === null || input.refunds === undefined
      ? "refunds"
      : null,
  ].filter(
    (field): field is UnitEconomicsInputField => field !== null,
  );

  return {
    netRevenue: calculateMetric(
      "currency",
      [
        value("revenue", input.revenue),
        value("refunds", input.refunds),
      ],
      ([revenue, refunds]) => revenue - refunds,
    ),
    cpl: calculateDivision(
      "currency",
      value("adSpend", input.adSpend),
      value("leads", input.leads),
    ),
    cac: calculateDivision(
      "currency",
      value(acquisitionExpenseField, acquisitionExpense),
      value("newCustomers", input.newCustomers),
    ),
    cpo: calculateDivision(
      "currency",
      value("adSpend", input.adSpend),
      value("sales", input.sales),
    ),
    averageCheck: calculateDivision(
      "currency",
      value("revenue", input.revenue),
      value("sales", input.sales),
    ),
    leadToApplicationConversion: calculatePercentage(
      value("applications", input.applications),
      value("leads", input.leads),
    ),
    applicationToCallConversion: calculatePercentage(
      value("calls", input.calls),
      value("applications", input.applications),
    ),
    callToSaleConversion: calculatePercentage(
      value("sales", input.sales),
      value("calls", input.calls),
    ),
    leadToSaleConversion: calculatePercentage(
      value("sales", input.sales),
      value("leads", input.leads),
    ),
    grossProfit: calculateMetric(
      "currency",
      [
        value("revenue", input.revenue),
        value("refunds", input.refunds),
        value("commissions", input.commissions),
        value("costOfGoods", input.costOfGoods),
      ],
      ([revenue, refunds, commissions, costOfGoods]) =>
        revenue - refunds - commissions - costOfGoods,
    ),
    profit: calculateMetric(
      "currency",
      [
        value("revenue", input.revenue),
        value("refunds", input.refunds),
        value("commissions", input.commissions),
        value("costOfGoods", input.costOfGoods),
        value(marketingExpenseField, marketingExpense),
        value("otherOperatingExpenses", input.otherOperatingExpenses),
      ],
      ([
        revenue,
        refunds,
        commissions,
        costOfGoods,
        marketingCosts,
        otherOperatingExpenses,
      ]) =>
        revenue -
        refunds -
        commissions -
        costOfGoods -
        marketingCosts -
        otherOperatingExpenses,
    ),
    margin: calculateMetric(
      "percentage",
      [
        value("revenue", input.revenue),
        value("refunds", input.refunds),
        value("commissions", input.commissions),
        value("costOfGoods", input.costOfGoods),
        value(marketingExpenseField, marketingExpense),
        value("otherOperatingExpenses", input.otherOperatingExpenses),
      ],
      ([
        revenue,
        refunds,
        commissions,
        costOfGoods,
        marketingCosts,
        otherOperatingExpenses,
      ]) => {
        const netRevenue = revenue - refunds;
        const profit =
          netRevenue -
          commissions -
          costOfGoods -
          marketingCosts -
          otherOperatingExpenses;

        return profit / netRevenue * 100;
      },
      () => netRevenueValue === 0,
    ),
    roas: calculateDivision(
      "ratio",
      {
        field: "revenue",
        value: netRevenueValue,
      },
      value("adSpend", input.adSpend),
      missingNetRevenueInputs,
    ),
    romi: calculateMetric(
      "ratio",
      [
        value("revenue", input.revenue),
        value("refunds", input.refunds),
        value(marketingExpenseField, marketingExpense),
      ],
      ([revenue, refunds, marketingCosts]) =>
        (revenue - refunds - marketingCosts) / marketingCosts,
      ([, , marketingCosts]) => marketingCosts === 0,
    ),
  };
}

export function calculatePlanFact(
  inputs: PlanFactInput[],
): PlanFactResult[] {
  return inputs.map(({ metric, plan, actual }) => {
    if (!metric.trim()) {
      throw new Error("Plan-fact metric name is required.");
    }

    validateOptionalNumber(plan, `plan for ${metric}`);
    validateOptionalNumber(actual, `actual for ${metric}`);

    if (plan === null || plan === undefined || actual === null || actual === undefined) {
      return {
        metric,
        plan: plan ?? null,
        actual: actual ?? null,
        absoluteVariance: null,
        variancePercent: null,
        completionPercent: null,
        status: "missing_input",
      };
    }

    if (plan === 0) {
      return {
        metric,
        plan,
        actual,
        absoluteVariance: actual,
        variancePercent: null,
        completionPercent: null,
        status: "zero_plan",
      };
    }

    const absoluteVariance = actual - plan;

    return {
      metric,
      plan,
      actual,
      absoluteVariance,
      variancePercent: absoluteVariance / plan * 100,
      completionPercent: actual / plan * 100,
      status: "calculated",
    };
  });
}

function calculatePercentage(
  numerator: MetricInputValue,
  denominator: MetricInputValue,
) {
  return calculateDivision(
    "percentage",
    numerator,
    denominator,
    [],
    100,
  );
}

function calculateDivision(
  unit: MetricUnit,
  numerator: MetricInputValue,
  denominator: MetricInputValue,
  additionalMissingInputs: UnitEconomicsInputField[] = [],
  multiplier = 1,
): CalculatedMetric {
  const missingInputs = [
    ...additionalMissingInputs,
    ...[numerator, denominator]
      .filter(({ value: inputValue }) => inputValue === null || inputValue === undefined)
      .map(({ field }) => field),
  ];

  if (missingInputs.length) {
    return missingMetric(unit, missingInputs);
  }

  if (denominator.value === 0) {
    return zeroDenominatorMetric(unit);
  }

  return calculatedMetric(
    unit,
    (numerator.value as number) / (denominator.value as number) * multiplier,
  );
}

function calculateMetric(
  unit: MetricUnit,
  inputs: MetricInputValue[],
  formula: (values: number[]) => number,
  hasZeroDenominator?: (values: number[]) => boolean,
): CalculatedMetric {
  const missingInputs = inputs
    .filter(({ value: inputValue }) => inputValue === null || inputValue === undefined)
    .map(({ field }) => field);

  if (missingInputs.length) {
    return missingMetric(unit, missingInputs);
  }

  const values = inputs.map(({ value: inputValue }) => inputValue as number);

  if (hasZeroDenominator?.(values)) {
    return zeroDenominatorMetric(unit);
  }

  return calculatedMetric(unit, formula(values));
}

function value(
  field: UnitEconomicsInputField,
  inputValue: number | null | undefined,
): MetricInputValue {
  return { field, value: inputValue };
}

function calculatedMetric(
  unit: MetricUnit,
  metricValue: number,
): CalculatedMetric {
  return {
    status: "calculated",
    value: metricValue,
    unit,
    missingInputs: [],
  };
}

function missingMetric(
  unit: MetricUnit,
  missingInputs: UnitEconomicsInputField[],
): CalculatedMetric {
  return {
    status: "missing_input",
    value: null,
    unit,
    missingInputs: [...new Set(missingInputs)],
  };
}

function zeroDenominatorMetric(unit: MetricUnit): CalculatedMetric {
  return {
    status: "zero_denominator",
    value: null,
    unit,
    missingInputs: [],
  };
}

function validateInput(input: UnitEconomicsInput) {
  for (const [field, inputValue] of Object.entries(input)) {
    validateOptionalNumber(inputValue, field);

    if (typeof inputValue === "number" && inputValue < 0) {
      throw new RangeError(`${field} cannot be negative.`);
    }
  }
}

function validateOptionalNumber(valueToValidate: unknown, field: string) {
  if (
    valueToValidate !== null &&
    valueToValidate !== undefined &&
    (typeof valueToValidate !== "number" ||
      !Number.isFinite(valueToValidate))
  ) {
    throw new TypeError(`${field} must be a finite number.`);
  }
}
