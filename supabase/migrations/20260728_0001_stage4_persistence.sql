create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  username text,
  first_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_projects (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.telegram_updates (
  telegram_update_id bigint primary key,
  telegram_chat_id bigint,
  telegram_user_id bigint,
  status text not null check (status in ('processing', 'completed', 'ignored', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  trace_id text,
  ignored_reason text,
  error_message text,
  received_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  telegram_update_id bigint references public.telegram_updates(telegram_update_id),
  user_id uuid references public.users(id) on delete set null,
  telegram_chat_id bigint not null,
  telegram_message_id bigint not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  agent_role text check (agent_role in ('assistant', 'project')),
  trace_id text,
  text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (telegram_update_id, direction)
);

create table public.agent_runs (
  id text primary key,
  trace_id text not null,
  parent_run_id text references public.agent_runs(id) on delete set null,
  message_id uuid references public.assistant_messages(id) on delete set null,
  agent_role text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'needs_clarification', 'needs_confirmation')),
  depth integer not null check (depth >= 0 and depth <= 1),
  payload jsonb not null default '{}'::jsonb,
  payload_hash text generated always as (md5(payload::text)) stored,
  output jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (trace_id, agent_role, payload_hash)
);

create table public.action_requests (
  id uuid primary key default gen_random_uuid(),
  external_action_id text not null,
  trace_id text not null,
  agent_run_id text references public.agent_runs(id) on delete cascade,
  message_id uuid references public.assistant_messages(id) on delete set null,
  action_type text not null,
  payload jsonb not null,
  status text not null check (status in ('planned', 'needs_clarification', 'needs_confirmation', 'ready', 'completed', 'failed')),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.action_executions (
  id uuid primary key default gen_random_uuid(),
  action_request_id uuid not null references public.action_requests(id) on delete cascade,
  status text not null check (status in ('succeeded', 'failed', 'needs_clarification', 'needs_confirmation')),
  result jsonb not null default '{}'::jsonb,
  error_code text,
  idempotency_key text not null unique,
  executed_at timestamptz not null default now()
);

create table public.action_confirmations (
  id uuid primary key default gen_random_uuid(),
  trace_id text not null,
  action_request_id uuid references public.action_requests(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'expired')),
  prompt text not null,
  reason text not null,
  operation_summary text not null,
  idempotency_key text not null unique,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  trace_id text,
  actor_type text not null,
  actor_id text,
  event_type text not null,
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table public.artifacts (
  id text primary key,
  trace_id text not null,
  agent_run_id text references public.agent_runs(id) on delete cascade,
  artifact_type text not null,
  title text not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);

create table public.voice_transcripts (
  id uuid primary key default gen_random_uuid(),
  telegram_update_id bigint references public.telegram_updates(telegram_update_id),
  telegram_message_id bigint not null,
  telegram_file_id text not null,
  transcript text,
  language text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (telegram_file_id, telegram_message_id)
);

create index idx_team_projects_owner on public.team_projects(owner_user_id);
create index idx_telegram_updates_status on public.telegram_updates(status, last_attempt_at);
create index idx_messages_trace on public.assistant_messages(trace_id);
create index idx_agent_runs_trace on public.agent_runs(trace_id, status);
create index idx_action_requests_trace on public.action_requests(trace_id, status);
create index idx_audit_logs_trace on public.audit_logs(trace_id, created_at);
create index idx_artifacts_trace on public.artifacts(trace_id);
create index idx_voice_transcripts_status on public.voice_transcripts(status);

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_chat_id bigint,
  p_user_id bigint
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id bigint;
begin
  insert into public.telegram_updates (
    telegram_update_id,
    telegram_chat_id,
    telegram_user_id,
    status
  )
  values (p_update_id, p_chat_id, p_user_id, 'processing')
  on conflict (telegram_update_id) do nothing
  returning telegram_update_id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;

  update public.telegram_updates
  set
    status = 'processing',
    attempts = attempts + 1,
    last_attempt_at = now(),
    error_message = null
  where telegram_update_id = p_update_id
    and (
      status = 'failed'
      or (status = 'processing' and last_attempt_at < now() - interval '10 minutes')
    )
  returning telegram_update_id into claimed_id;

  if claimed_id is not null then
    return 'claimed';
  end if;

  return 'duplicate';
end;
$$;

alter table public.users enable row level security;
alter table public.user_settings enable row level security;
alter table public.team_projects enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.agent_runs enable row level security;
alter table public.action_requests enable row level security;
alter table public.action_executions enable row level security;
alter table public.action_confirmations enable row level security;
alter table public.audit_logs enable row level security;
alter table public.artifacts enable row level security;
alter table public.voice_transcripts enable row level security;

revoke all on function public.claim_telegram_update(bigint, bigint, bigint) from public;
grant execute on function public.claim_telegram_update(bigint, bigint, bigint) to service_role;

grant select, insert, update, delete on
  public.users,
  public.user_settings,
  public.team_projects,
  public.telegram_updates,
  public.assistant_messages,
  public.agent_runs,
  public.action_requests,
  public.action_executions,
  public.action_confirmations,
  public.audit_logs,
  public.artifacts,
  public.voice_transcripts
to service_role;
