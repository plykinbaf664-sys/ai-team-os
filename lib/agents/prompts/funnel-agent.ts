export const funnelAgentInstructions = [
  "Ты Funnel Agent внутри AI Team OS.",
  "Тебя запускает только Project Agent после Research Agent и Product Agent.",
  "Построй практичную воронку на русском языке строго на основе переданных artifacts.",
  "Свяжи точку входа, лид-магнит, этапы, касания, квалификацию и переход в оффер.",
  "Не придумывай доказательства, фактические конверсии, бюджет или результаты клиентов.",
  "Целевые значения метрик указывай только как проверяемые гипотезы.",
  "Не подменяй продукт и позиционирование: используй Product artifact как источник истины.",
  "Отделяй evidence от assumptions и явно фиксируй риски.",
  "Воронка должна быть измеримой: у каждого этапа нужны действие и критерий успеха.",
  "Не вызывай другие агенты и не описывай процесс своей работы.",
].join("\n");

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

export const funnelArtifactSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "entryPoint",
    "leadMagnet",
    "stages",
    "conversionEvents",
    "touchpoints",
    "handoff",
    "metrics",
    "assumptions",
    "evidence",
    "risks",
  ],
  properties: {
    summary: { type: "string" },
    entryPoint: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "audience", "promise"],
      properties: {
        channel: { type: "string" },
        audience: { type: "string" },
        promise: { type: "string" },
      },
    },
    leadMagnet: {
      type: "object",
      additionalProperties: false,
      required: ["title", "format", "value", "nextStep"],
      properties: {
        title: { type: "string" },
        format: { type: "string" },
        value: { type: "string" },
        nextStep: { type: "string" },
      },
    },
    stages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "objective",
          "userAction",
          "systemResponse",
          "successMetric",
        ],
        properties: {
          name: { type: "string" },
          objective: { type: "string" },
          userAction: { type: "string" },
          systemResponse: { type: "string" },
          successMetric: { type: "string" },
        },
      },
    },
    conversionEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "fromStage", "toStage", "measurement"],
        properties: {
          name: { type: "string" },
          fromStage: { type: "string" },
          toStage: { type: "string" },
          measurement: { type: "string" },
        },
      },
    },
    touchpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stage", "channel", "messageGoal"],
        properties: {
          stage: { type: "string" },
          channel: { type: "string" },
          messageGoal: { type: "string" },
        },
      },
    },
    handoff: {
      type: "object",
      additionalProperties: false,
      required: ["targetOffer", "qualificationCriteria"],
      properties: {
        targetOffer: { type: "string" },
        qualificationCriteria: stringArray,
      },
    },
    metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "definition", "targetHypothesis"],
        properties: {
          name: { type: "string" },
          definition: { type: "string" },
          targetHypothesis: { type: "string" },
        },
      },
    },
    assumptions: stringArray,
    evidence: stringArray,
    risks: stringArray,
  },
};
