create table public.project_resources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.team_projects(id) on delete cascade,
  resource_type text not null check (
    resource_type in ('google_sheet', 'ticktick_project')
  ),
  external_id text not null,
  title text not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (
    status in ('active', 'archived')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, resource_type, external_id)
);

create table public.sheet_profiles (
  id uuid primary key default gen_random_uuid(),
  project_resource_id uuid references public.project_resources(id) on delete set null,
  spreadsheet_id text not null,
  sheet_id bigint not null,
  sheet_name text not null,
  purpose text not null,
  entity_type text not null check (
    entity_type in (
      'outreach_segment',
      'task',
      'metric_record',
      'activity_log',
      'generic_table'
    )
  ),
  header_row_number integer not null check (header_row_number > 0),
  row_matching_rules jsonb not null default '{}'::jsonb,
  linked_ticktick_project_id text,
  fingerprint text not null,
  profile_version integer not null default 1 check (profile_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (spreadsheet_id, sheet_id)
);

create table public.sheet_column_profiles (
  id uuid primary key default gen_random_uuid(),
  sheet_profile_id uuid not null references public.sheet_profiles(id) on delete cascade,
  column_index integer not null check (column_index >= 0),
  column_letter text not null,
  header text not null,
  semantic_key text not null,
  role text not null check (
    role in ('key', 'metric', 'status', 'text', 'formula', 'unknown')
  ),
  data_type text not null check (
    data_type in ('string', 'number', 'boolean', 'date', 'mixed', 'empty')
  ),
  update_policy text not null check (
    update_policy in (
      'preserve',
      'increment',
      'replace',
      'append_text',
      'formula',
      'protected'
    )
  ),
  is_formula boolean not null default false,
  is_protected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sheet_profile_id, column_index),
  unique (sheet_profile_id, semantic_key)
);

create table public.sheet_row_entities (
  id uuid primary key default gen_random_uuid(),
  sheet_profile_id uuid not null references public.sheet_profiles(id) on delete cascade,
  entity_id text not null,
  row_number integer not null check (row_number > 0),
  row_key text not null,
  normalized_key text not null,
  aliases text[] not null default '{}',
  confidence numeric(4, 3),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sheet_profile_id, entity_id)
);

create index idx_project_resources_project
  on public.project_resources(project_id, status);
create index idx_sheet_profiles_resource
  on public.sheet_profiles(project_resource_id);
create index idx_sheet_profiles_external
  on public.sheet_profiles(spreadsheet_id, sheet_id);
create index idx_sheet_columns_profile
  on public.sheet_column_profiles(sheet_profile_id, role);
create index idx_sheet_entities_profile
  on public.sheet_row_entities(sheet_profile_id, normalized_key);

alter table public.project_resources enable row level security;
alter table public.sheet_profiles enable row level security;
alter table public.sheet_column_profiles enable row level security;
alter table public.sheet_row_entities enable row level security;

grant select, insert, update, delete on
  public.project_resources,
  public.sheet_profiles,
  public.sheet_column_profiles,
  public.sheet_row_entities
to service_role;
