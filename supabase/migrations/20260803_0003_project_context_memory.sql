alter table public.user_settings
  add column if not exists active_project_id uuid references public.team_projects(id) on delete set null,
  add column if not exists preferred_response_style text;

alter table public.action_requests
  add column if not exists project_id uuid references public.team_projects(id) on delete set null;

create table public.project_glossary (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.team_projects(id) on delete cascade,
  term text not null,
  definition text not null,
  aliases text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, term)
);

create table public.project_operating_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.team_projects(id) on delete cascade,
  rule_key text not null,
  rule_text text not null,
  priority integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, rule_key)
);

create table public.assistant_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.team_projects(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  decision text not null,
  rationale text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (
    status in ('active', 'superseded', 'archived')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_user_settings_active_project
  on public.user_settings(active_project_id);
create index idx_action_requests_project
  on public.action_requests(project_id, created_at desc);
create index idx_project_glossary_project
  on public.project_glossary(project_id, status);
create index idx_project_rules_project
  on public.project_operating_rules(project_id, status, priority desc);
create index idx_assistant_decisions_project
  on public.assistant_decisions(project_id, status, created_at desc);

alter table public.project_glossary enable row level security;
alter table public.project_operating_rules enable row level security;
alter table public.assistant_decisions enable row level security;

grant select, insert, update, delete on
  public.project_glossary,
  public.project_operating_rules,
  public.assistant_decisions
to service_role;
