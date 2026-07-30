export type UnitEconomicsInput = {
  revenue?: number | null;
  refunds?: number | null;
  adSpend?: number | null;
  marketingCosts?: number | null;
  acquisitionCosts?: number | null;
  otherOperatingExpenses?: number | null;
  commissions?: number | null;
  costOfGoods?: number | null;
  leads?: number | null;
  applications?: number | null;
  calls?: number | null;
  sales?: number | null;
  newCustomers?: number | null;
};

export type UnitEconomicsInputField = keyof UnitEconomicsInput;

export type MetricUnit = "currency" | "percentage" | "ratio";

export type CalculatedMetric =
  | {
      status: "calculated";
      value: number;
      unit: MetricUnit;
      missingInputs: [];
    }
  | {
      status: "missing_input";
      value: null;
      unit: MetricUnit;
      missingInputs: UnitEconomicsInputField[];
    }
  | {
      status: "zero_denominator";
      value: null;
      unit: MetricUnit;
      missingInputs: [];
    };

export type UnitEconomicsReport = {
  netRevenue: CalculatedMetric;
  cpl: CalculatedMetric;
  cac: CalculatedMetric;
  cpo: CalculatedMetric;
  averageCheck: CalculatedMetric;
  leadToApplicationConversion: CalculatedMetric;
  applicationToCallConversion: CalculatedMetric;
  callToSaleConversion: CalculatedMetric;
  leadToSaleConversion: CalculatedMetric;
  grossProfit: CalculatedMetric;
  profit: CalculatedMetric;
  margin: CalculatedMetric;
  roas: CalculatedMetric;
  romi: CalculatedMetric;
};

export type PlanFactInput = {
  metric: string;
  plan: number | null | undefined;
  actual: number | null | undefined;
};

export type PlanFactResult = {
  metric: string;
  plan: number | null;
  actual: number | null;
  absoluteVariance: number | null;
  variancePercent: number | null;
  completionPercent: number | null;
  status: "calculated" | "missing_input" | "zero_plan";
};
