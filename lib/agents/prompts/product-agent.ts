export const productAgentInstructions = [
  "Ты Product Agent внутри AI Team OS.",
  "Тебя запускает только Project Agent после Research Agent.",
  "Создай практичную продуктовую гипотезу на русском языке строго на основе переданного Research artifact.",
  "Отделяй подтверждённые наблюдения от предположений.",
  "Не придумывай рыночные факты, цены, спрос, результаты клиентов или доказательства.",
  "Если данных недостаточно, зафиксируй это в assumptions, proofNeeded или risks.",
  "Сегменты, позиционирование, оффер, MVP, продуктовая линейка и лид-магнит должны быть связаны одной логикой.",
  "Цену указывай только как проверяемую гипотезу, а не как установленный факт.",
  "Evidence формулируй кратко и привязывай к содержанию Research artifact.",
  "Не вызывай другие агенты и не описывай процесс своей работы.",
].join("\n");

const stringArray = {
  type: "array",
  items: { type: "string" },
} as const;

export const productArtifactSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "audienceSegments",
    "positioning",
    "productHypothesis",
    "offer",
    "mvp",
    "productLine",
    "leadMagnet",
    "assumptions",
    "evidence",
    "risks",
  ],
  properties: {
    summary: { type: "string" },
    audienceSegments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pains", "desiredOutcome", "evidence"],
        properties: {
          name: { type: "string" },
          pains: stringArray,
          desiredOutcome: { type: "string" },
          evidence: stringArray,
        },
      },
    },
    positioning: stringArray,
    productHypothesis: {
      type: "object",
      additionalProperties: false,
      required: ["audience", "problem", "solution", "expectedResult"],
      properties: {
        audience: { type: "string" },
        problem: { type: "string" },
        solution: { type: "string" },
        expectedResult: { type: "string" },
      },
    },
    offer: {
      type: "object",
      additionalProperties: false,
      required: ["promise", "mechanism", "proofNeeded"],
      properties: {
        promise: { type: "string" },
        mechanism: { type: "string" },
        proofNeeded: stringArray,
      },
    },
    mvp: {
      type: "object",
      additionalProperties: false,
      required: ["name", "format", "scope", "successCriteria"],
      properties: {
        name: { type: "string" },
        format: { type: "string" },
        scope: stringArray,
        successCriteria: stringArray,
      },
    },
    productLine: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "format", "priceHypothesis", "result"],
        properties: {
          name: { type: "string" },
          format: { type: "string" },
          priceHypothesis: { type: "string" },
          result: { type: "string" },
        },
      },
    },
    leadMagnet: {
      type: "object",
      additionalProperties: false,
      required: ["title", "format", "nextStep"],
      properties: {
        title: { type: "string" },
        format: { type: "string" },
        nextStep: { type: "string" },
      },
    },
    assumptions: stringArray,
    evidence: stringArray,
    risks: stringArray,
  },
};
