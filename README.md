This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

_____________________________________________________________________________
16.06.2026

Сделали первый рабочий MVP для нового проекта AI Team OS.

  Что конкретно:

  1. Создали отдельный репозиторий:

  https://github.com/plykinbaf664-sys/ai-team-os

  2. Создали Next.js-проект в:

  C:\Users\User\ai-team-os

  3. Настроили git:

  main
  origin -> GitHub

  4. Создали рабочую ветку:

  ai-team-os/mvp-telegram-project-assistant

  5. Собрали MVP-архитектуру:

  app/api/telegram/webhook/route.ts
  lib/telegram/types.ts
  lib/telegram/send-message.ts
  lib/agents/agent-router.ts
  lib/agents/agent-registry.ts
  lib/agents/loop-guard.ts
  lib/agents/prompts/project-assistant.ts

  6. Реализовали первый сценарий:

  Telegram group chat
  -> сообщение начинается с project
  -> webhook принимает update
  -> Agent Router вызывает Project Assistant
  -> OpenAI генерирует ответ
  -> бот отвечает обратно в Telegram

  7. Добавили ограничения против бесконечного общения агентов:

  напрямую можно вызвать только project
  остальные агенты пока отключены
  Project Assistant пока не запускает цепочки агентов

  8. Настроили .env.local локально:

  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  OPENAI_API_KEY

  .env.local не попал в git.

  9. Подняли ngrok:

  https://bronze-tinkling-definite.ngrok-free.dev

  10. Установили Telegram webhook:

  https://bronze-tinkling-definite.ngrok-free.dev/api/telegram/webhook

  11. Проверили в Telegram, что бот отвечает на:

  project привет
  project что ты умеешь?

  12. Закоммитили MVP:

  88b9ba9 feat: add telegram project assistant mvp

  13. Запушили ветку на GitHub.
  14. Слили MVP в main.

  Итоговое состояние:

  main содержит рабочий MVP
  рабочее дерево чистое
  сервер остановлен

  Главное: у нас теперь есть первая рабочая версия AI Team OS, где Telegram-группа управляет Project Assistant через
  команду project.
____________________________________________________
• Сегодня сделали по системе AI Team OS:

  1. Подняли и проверили связку Telegram -> ngrok -> Next.js webhook -> OpenAI -> Telegram.
  2. Оставили рабочие команды:
     project, проджект, research, ресерч.
  3. Настроили Research Agent как отдельного агента:
     его можно вызывать напрямую через research/ресерч, а Project Assistant может передавать ему задачи.
  4. Добавили защиту от кривого анализа конкурентов:
     если пользователь просит анализ конкурентов, но не указал количество или критерии, Research сначала спрашивает
     уточнение.
  5. Исправили проблему, когда Research терял исходную нишу после уточнения критериев:
     теперь он сохраняет первую задачу и объединяет ее со следующим сообщением пользователя.
  6. Добавили генерацию research-отчета файлом:
     Research делает отчет в Markdown и отправляет его в Telegram как документ.
  7. Исправили проблему с битой кодировкой в файле:
     добавили UTF-8 BOM для нормального открытия русских отчетов.
  8. Добавили сообщение о принятии задачи:
     Research пишет, что принял задачу, только когда реально начинает делать исследование, а не после каждого сообщения.
  9. Сильно усилили промпт Research Agent:
     теперь он должен работать как маркетолог-стратег и конкурентный аналитик, искать актуальные данные в интернете,
     разбирать рынок, деньги, конкурентов, офферы, цены, воронки, позиционирование, дыры рынка и давать жесткий
     прикладной вердикт.
  10. Сделали коммит:
     d339b97 feat: add research agent reports

  Следующие шаги:

  1. Протестировать Research Agent на 2-3 реальных нишах и сохранить плохие/хорошие примеры отчетов.
  2. Доработать качество research-процесса:
     не одним большим запросом, а в 2 этапа:
     сначала найти релевантных конкурентов и ссылки, потом глубоко разобрать каждого конкурента.
  3. Добавить структуру памяти/истории задач:
     чтобы агент понимал, какую нишу мы уже исследовали, какие критерии задавали и какие выводы были раньше.
  4. Добавить Product Agent:
     он должен брать research-отчет и превращать его в продуктовую гипотезу: ЦА, оффер, продуктовая линейка, первый MVP,
     чек, упаковка.
  5. Добавить Marketing Agent:
     он должен на базе продукта делать воронку: лид-магнит, прогрев, лендинг, сообщения, контент, рекламные углы.
  6. Настроить нормальный формат документов:
     чтобы отчеты были не просто .md, а могли сохраняться в Google Docs/Notion или в отдельную папку проекта.
  7. Позже добавить голосовые:
     чтобы Telegram принимал голосовые, расшифровывал их и передавал текст агентам.

  Главный текущий фокус: довести Research Agent до уровня, где он стабильно выдает не “общий обзор”, а конкретную
  разведку для запуска продукта.


› Summarize recent commits

  gpt-5.5 default · ~\ai-team-os
  └ [main d339b97] feat: add research agent reports
     7 files changed, 640 insertions(+), 28 deletions(-)
     create mode 100644 lib/agents/prompts/research-agent.ts
     create mode 100644 lib/telegram/send-document.ts

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• Коммит создан. Сейчас проверю финальный статус, чтобы подтвердить, что в коммит не попали лишние файлы.

• Running git status --short

• Ran git log -1 --oneline
  └ d339b97 feat: add research agent reports

• Ran git status --short
  └  M AGENTS.md
     M README.md

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• Сделал коммит:

  d339b97 feat: add research agent reports

  В коммит вошли только кодовые изменения по Research Agent:

  - direct вызов research/ресерч
  - делегирование из Project в Research
  - уточнение количества конкурентов и критериев
  - генерация Markdown-отчета через web search
  - отправка отчета файлом в Telegram
  - UTF-8 фиксация для русской кодировки
  - усиленный промпт маркетингового анализа

  AGENTS.md и README.md остались незакоммиченными, я их специально не трогал в коммите.
__________________________
AI Team OS - обновление 25.07.2026

Внутренняя Telegram-first система управления личным AI-ассистентом и AI-командой для клиентских проектов.

Проект создаётся как отдельный репозиторий и не является коммерческим SaaS-продуктом или шаблоном для продажи. Его задача — закрывать личную операционную работу пользователя и координировать производство результатов по клиентским проектам через специализированных AI-агентов.

1. Главная идея

В Telegram используется один физический бот, внутри которого работают разные независимые роли.

Два верхнеуровневых агента:

Assistant Agent — личный ассистент пользователя.

Project Agent — руководитель AI-команды по клиентским проектам.

Они не вызывают друг друга, не передают друг другу задачи и не ведут автоматический диалог между собой.

Пользователь сам выбирает, к кому обратиться:

/assistant — личная и операционная работа
/project   — комплексная работа по клиентскому проекту

2. Архитектура агентов

Пользователь
├── Assistant Agent
│   └── личные дела и внутренние проекты пользователя
│
└── Project Agent
    └── клиентские проекты и управление AI-командой
        ├── Research Agent
        ├── Product Agent
        ├── Funnel Agent
        ├── Content Agent
        ├── Scraper Agent
        ├── Social Copywriter
        └── Reels Scriptwriter

Ключевое ограничение

Assistant Agent ≠ Project Agent

Assistant Agent не управляет специализированными агентами.

Project Agent не занимается личной операционкой пользователя.

Assistant Agent не вызывает Project Agent.

Project Agent не вызывает Assistant Agent.

Специализированные агенты не вызывают друг друга.

Только Project Agent может запускать специализированных агентов.

3. Assistant Agent

Канонический slug:

assistant

Assistant Agent — личный AI-ассистент пользователя.

Он работает с личными делами, операционной нагрузкой и собственными внутренними проектами пользователя.

Основные функции

принимать текстовые и голосовые поручения в Telegram;

создавать и обновлять задачи;

назначать дедлайны и приоритеты;

вести календарь и события;

обновлять показатели проектов;

считать юнит-экономику;

готовить ежедневные сводки;

создавать и обновлять Google Sheets;

вести аналитику по внутренним проектам;

фиксировать статусы, решения и изменения;

выполнять пакетные команды из одного сообщения.

Google Sheets

Assistant Agent должен уметь создавать полноценные таблицы с нуля:

проектировать структуру листов;

создавать заголовки и колонки;

добавлять формулы;

настраивать фильтры;

создавать выпадающие списки;

применять условное форматирование;

закреплять строки и столбцы;

добавлять графики;

собирать дашборды;

делать план-факт;

добавлять автоматические расчёты;

обновлять строки и статусы;

создавать таблицы под конкретную управленческую задачу.

ИИ проектирует таблицу как типизированный blueprint. Фактическое создание и форматирование выполняется обычным кодом через Google Sheets API.

TickTick

Assistant Agent создаёт только конкретные задачи, которые должны привести к определённому результату.

Примеры нормальных задач:

Подготовить презентацию к пятнице
Согласовать оффер с Мариной
Проверить лендинг до 30 июля

Массовые процессовые действия не дробятся на десятки задач:

Написать 90 людям
Обработать всю базу
Каждый день отвечать на комментарии

Google Calendar

В календарь добавляются только события с конкретным временным слотом:

созвоны;

встречи;

выступления;

мероприятия;

другие временные обязательства.

Обычная задача без конкретного времени идёт в TickTick, а не в Calendar.

Юнит-экономика

Assistant Agent работает с показателями:

расходы;

рекламные расходы;

выручка;

лиды;

заявки;

созвоны;

продажи;

возвраты;

комиссии;

себестоимость;

CPL;

CAC;

CPO;

средний чек;

конверсии;

маржа;

прибыль;

ROAS;

ROMI;

план и факт.

Расчёты выполняются детерминированным TypeScript-кодом. LLM не используется как калькулятор.

Режимы работы

quick_command
batch_report
create_structure
analytics
daily_summary

4. Project Agent

Канонический slug:

project

Project Agent — руководитель AI-команды по клиентским проектам.

Пользователь обращается к нему напрямую, когда нужна комплексная работа по конкретному клиенту.

Пример:

/project построй стратегию запуска для клиента-психолога

Основные функции

понять цель проекта;

получить недостающий контекст;

создать проектный план;

разбить цель на этапы;

выбрать специализированных агентов;

определить порядок их работы;

передавать контекст и артефакты между этапами;

контролировать критерии готовности;

фиксировать статусы;

останавливать workflow при ошибке или нехватке данных;

собирать финальный пакет результата.

Специализированные агенты

Research Agent

Собирает и структурирует:

отзывы;

боли;

страхи;

желания;

вопросы;

конкурентов;

рыночные формулировки;

доказательства и источники.

Существующий Research OS должен подключаться через adapter или API-контракт, а не переноситься целиком в проект.

Product Agent

На базе Research Artifact создаёт:

сегменты аудитории;

позиционирование;

продуктовую гипотезу;

оффер;

продуктовую линейку;

лид-магнит.

Funnel Agent

Создаёт:

путь пользователя;

механику воронки;

этапы прогрева;

Telegram-flow;

квалификацию;

переход к заявке, созвону или оплате.

Content Agent

Создаёт:

контентную стратегию;

план прогрева;

распределение по площадкам;

темы;

рубрики;

логику касаний;

связь контента с воронкой.

Scraper Agent

Исследует, что работает сейчас:

Instagram;

TikTok;

YouTube;

другие разрешённые источники.

Возвращает:

темы;

форматы;

хуки;

паттерны;

примеры;

ссылки;

сигналы популярности.

Scraper Agent не пишет финальный контент.

Social Copywriter

Пишет материалы для разных площадок:

Telegram-посты;

Instagram-посты;

карусели;

email;

тексты воронки;

лид-магниты.

Reels Scriptwriter

Отдельно создаёт:

идеи коротких видео;

хуки;

структуру сценария;

текст речи;

текст на экран;

визуальные указания;

CTA.

5. Telegram-маршрутизация

Используется один физический Telegram-бот.

Личный чат

/assistant — вызывает Assistant Agent
/project   — вызывает Project Agent

Обычное личное поручение может по умолчанию идти Assistant Agent, если это явно зафиксировано в настройках.

Рабочая группа

@assistant или /assistant — Assistant Agent
@project или /project     — Project Agent

Сообщение без явного обращения игнорируется.

Контроль доступа

Система должна поддерживать:

allowed_user_ids
allowed_chat_ids

Посторонний пользователь не должен управлять системой.

6. Общий архитектурный принцип

LLM используется только для:

понимания естественного языка;

транскрибации;

классификации запроса;

выделения сущностей;

построения типизированного плана;

аналитических выводов;

определения необходимости уточнения или подтверждения.

LLM не должен напрямую:

выполнять SQL;

менять таблицы;

создавать задачи;

создавать события;

вычислять финансовые показатели;

удалять данные;

формировать произвольные команды исполнения.

Все реальные действия выполняются обычным кодом через типизированные executors и API adapters.

7. Поток Assistant Agent

Telegram update
→ проверка доступа
→ проверка дубля
→ извлечение текста или транскрибация
→ определение режима
→ типизированный Action Plan
→ runtime validation
→ уточнение или подтверждение
→ deterministic executor
→ API adapter
→ проверка результата
→ audit log
→ короткий отчёт в Telegram

Базовые типы действий:

add_metrics
update_metrics
update_project_status
create_task
update_task
complete_task
create_calendar_event
update_calendar_event
create_sheet
create_sheet_tab
update_sheet
create_sheet_blueprint
analyze_metrics
generate_daily_summary

8. Поток Project Agent

Пользователь задаёт цель
→ Project Agent создаёт Project Plan
→ выбирает следующего агента
→ создаёт Agent Run
→ агент возвращает Artifact
→ Project Agent валидирует Artifact
→ запускает следующий этап
→ собирает финальный Project Report
→ завершает workflow

Project Agent не должен запускать всех агентов одновременно без необходимости.

Предпочтительная последовательность:

Research
→ Product
→ Funnel
→ Content
→ Scraper
→ Social Copywriter / Reels Scriptwriter
→ финальный пакет проекта

Последовательность может меняться в зависимости от цели проекта.

9. Защита от зацикливания

Обязательные правила:

корневой workflow запускает только пользователь;

Assistant Agent и Project Agent не вызывают друг друга;

специализированные агенты вызываются только Project Agent;

специализированный агент не запускает другого агента;

ответ бота не считается новым пользовательским запросом;

каждый workflow имеет trace_id;

дочерний запуск имеет parent_run_id;

одинаковый агент с одинаковым payload не запускается повторно внутри одного trace;

в MVP max_agent_depth = 1;

после финального результата workflow закрывается;

свободное bot-to-bot общение запрещено.

10. Безопасность

Подтверждение обязательно перед:

удалением данных;

удалением задач;

удалением событий;

массовым обновлением;

массовым переносом;

очисткой таблиц;

изменением структуры существующей таблицы;

перезаписью большого диапазона;

необратимыми действиями.

Не требуют отдельного подтверждения:

добавление одной строки метрик;

создание одной явно указанной задачи;

создание одного явно указанного события;

обновление одного статуса;

получение аналитической сводки.

Если данных недостаточно, система задаёт один конкретный вопрос и ничего не придумывает.

11. Предпочтительный стек

Next.js App Router
Node.js
TypeScript
Telegram Bot API
OpenAI API
Supabase / PostgreSQL
Google Sheets API
Google Calendar API
TickTick API
pnpm

12. Предполагаемая структура проекта

app/
  api/
    telegram/
      webhook/

lib/
  telegram/

  agents/
    assistant/
    project/
    research/
    product/
    funnel/
    content/
    scraper/
    copy/
    reels/

  orchestration/
  actions/
  executors/
  confirmations/

  integrations/
    google-sheets/
    google-calendar/
    ticktick/
    openai/

  unit-economics/
  database/

supabase/
tests/

Не создавать папки ради папок. Структура должна адаптироваться под реальный код проекта.

13. Данные и память

Предполагаемые сущности:

users
user_settings
team_projects
project_settings
assistant_messages
agent_runs
action_requests
action_executions
action_confirmations
audit_logs
artifacts
voice_transcripts
launch_tasks
launch_events

Если сущность уже существует, её нужно переиспользовать или расширить, а не создавать дубль.

14. Этапы реализации

Stage 0 — Audit and Architecture

аудит репозитория;

проверка README и AGENTS;

поиск webhook и существующих модулей;

решение по структуре;

без изменения кода.

Stage 1 — Telegram Router and Agent Registry

/assistant;

/project;

allowlist;

mock-ответы;

игнорирование обычных сообщений;

базовый loop guard.

Stage 2 — Assistant Core and Mock Action Plan

типизированные actions;

clarification;

confirmation;

mock executor.

Stage 3 — Project Agent Core

Project Plan;

Agent Run;

Artifact;

mock Research Agent;

завершение workflow.

Stage 4 — Persistence, Audit and Idempotency

база;

trace;

статусы;

журнал;

защита от дублей.

Stage 5 — Voice Messages

загрузка;

транскрибация;

хранение;

передача в Assistant pipeline.

Stage 6 — Google Sheets

blueprint;

создание таблиц;

оформление;

формулы;

графики;

дашборды.

Stage 7 — Unit Economics

детерминированные формулы;

тесты;

план-факт.

Stage 8 — TickTick

создание и обновление задач;

приоритеты;

дедлайны;

защита от дублей.

Stage 9 — Google Calendar

события;

timezone;

проверка дублей;

обновление событий.

Stage 10 — Batch Reports

несколько действий из одного сообщения;

отдельный результат каждого действия;

частичный успех.

Stage 11 — Daily Summary

приоритеты;

просрочки;

события;

показатели;

отклонения.

Stage 12 — Real Research Agent Integration

adapter к существующему Research OS;

structured artifact;

сохранение результата.

Stage 13 — Project Team Expansion

По одному подключаются:

Product Agent

Funnel Agent

Content Agent

Scraper Agent

Social Copywriter

Reels Scriptwriter

15. Текущее состояние

Проект необходимо начинать с:

Stage 0 — Audit and Architecture

На этом этапе Codex должен:

изучить репозиторий;

определить, что уже существует;

предложить архитектуру;

указать, какие файлы понадобятся для Stage 1;

ничего не менять.

После каждой стадии:

сделал
→ запустил проверки
→ показал отчёт
→ остановился
→ ждёт подтверждение пользователя

16. Что не относится к проекту

В текущий scope не входит:

коммерческий SaaS;

продажа системы;

клиентские копии репозитория;

автономное бесконтрольное bot-to-bot общение;

перенос всех старых модулей в один монолит;

выполнение опасных действий без подтверждения;

автоматический переход между стадиями разработки без приёмки пользователя.

17. Критерий успеха MVP

Первая рабочая версия считается готовой, когда:

В Telegram существуют два независимых входа: Assistant Agent и Project Agent.

Assistant Agent понимает текстовое или голосовое поручение.

Assistant Agent создаёт типизированный набор действий.

Assistant Agent безопасно обновляет Google Sheets, TickTick и Calendar.

Assistant Agent считает показатели обычным кодом.

Project Agent создаёт план клиентского проекта.

Project Agent последовательно вызывает специализированных агентов.

Агенты не зацикливаются и не разговаривают бесконечно.

Все действия логируются.

Пользователь получает короткий понятный результат в Telegram.

18. Короткая формула проекта

Assistant Agent = личный исполнитель пользователя

Project Agent = руководитель AI-команды по клиентским проектам

AI Team OS = Telegram-интерфейс + маршрутизация + безопасное исполнение + управляемая агентная команда
_______________________________________


