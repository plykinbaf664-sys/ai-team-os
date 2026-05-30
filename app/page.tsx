const agents = [
  {
    name: "Project Assistant",
    command: "project",
    status: "active",
    scope: "Координация задач, уточнение следующего действия, ответы в Telegram.",
  },
  {
    name: "Research Agent",
    command: "research",
    status: "planned",
    scope: "Сбор фактов, ссылок и исходных материалов для запуска.",
  },
  {
    name: "Product Agent",
    command: "product",
    status: "planned",
    scope: "Упаковка оффера, структура продукта и приоритеты MVP.",
  },
  {
    name: "Content Agent",
    command: "content",
    status: "planned",
    scope: "Контент-план, посты, сценарии и повторяемые форматы.",
  },
];

const checks = [
  ["Webhook", "/api/telegram/webhook"],
  ["Telegram command", "project <задача>"],
  ["Runtime", "Next.js route handler"],
  ["Loop guard", "root agent only"],
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f7f3ea] text-[#161616]">
      <section className="border-b border-[#d8d0c2] bg-[#f7f3ea]">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:py-12">
          <div className="flex flex-col justify-between gap-10">
            <div>
              <p className="text-sm font-medium uppercase text-[#746b5b]">
                AI Team OS
              </p>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight text-[#161616] sm:text-5xl">
                Рабочий центр ИИ-команды для запусков в Telegram
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-[#4f4a42] sm:text-lg">
                MVP уже принимает сообщения из группы, маршрутизирует команду{" "}
                <span className="font-semibold text-[#161616]">project</span> и
                возвращает ответ Project Assistant обратно в чат.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {checks.map(([label, value]) => (
                <div
                  key={label}
                  className="border border-[#d8d0c2] bg-white px-4 py-3"
                >
                  <p className="text-xs font-medium uppercase text-[#746b5b]">
                    {label}
                  </p>
                  <p className="mt-1 break-words font-mono text-sm text-[#222]">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-[#c9bca8] bg-[#1d2b2a] p-5 text-white">
            <div className="flex items-center justify-between gap-4 border-b border-white/15 pb-4">
              <div>
                <p className="text-sm text-white/70">Current agent</p>
                <h2 className="text-2xl font-semibold">Project Assistant</h2>
              </div>
              <span className="bg-[#8bd3a7] px-3 py-1 text-xs font-semibold uppercase text-[#102018]">
                active
              </span>
            </div>

            <div className="mt-6 space-y-4">
              <div className="bg-white/8 p-4">
                <p className="text-xs uppercase text-white/55">Input</p>
                <p className="mt-2 font-mono text-sm text-white">
                  project сделай план запуска MVP
                </p>
              </div>
              <div className="bg-[#f0c56d] p-4 text-[#1a1712]">
                <p className="text-xs font-semibold uppercase text-[#67501b]">
                  Output
                </p>
                <p className="mt-2 text-sm leading-6">
                  Короткий план, следующий шаг, ответственный фокус и ограничение
                  без запуска цепочек агентов.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-2 text-center text-xs text-white/70">
                <div className="border border-white/15 py-3">Telegram</div>
                <div className="border border-white/15 py-3">Router</div>
                <div className="border border-white/15 py-3">OpenAI</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium uppercase text-[#746b5b]">
              Agent registry
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Состав команды</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-[#5c564c]">
            Сейчас напрямую вызывается только Project Assistant. Остальные роли
            оставлены в реестре как следующий этап архитектуры.
          </p>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <article
              key={agent.name}
              className="border border-[#d8d0c2] bg-white p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold">{agent.name}</h3>
                  <p className="mt-1 font-mono text-sm text-[#696154]">
                    /{agent.command}
                  </p>
                </div>
                <span
                  className={
                    agent.status === "active"
                      ? "bg-[#d8f3df] px-2.5 py-1 text-xs font-semibold uppercase text-[#1b6b36]"
                      : "bg-[#ece6dc] px-2.5 py-1 text-xs font-semibold uppercase text-[#766b5a]"
                  }
                >
                  {agent.status}
                </span>
              </div>
              <p className="mt-4 text-sm leading-6 text-[#4f4a42]">
                {agent.scope}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
