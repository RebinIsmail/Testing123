-- Middle-earth War Table shared game state, Supabase PostgreSQL.
-- Run in a Supabase project owned by the player. Uses guest Supabase Auth
-- (anonymous sign-in), not unauthenticated public database writes.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.wotr_rooms (
    id uuid primary key default gen_random_uuid(),
    secret_hash text not null,
    game_state jsonb not null,
    revision bigint not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint valid_state check (jsonb_typeof(game_state) = 'object')
);

alter table public.wotr_rooms enable row level security;
revoke all on public.wotr_rooms from anon, authenticated, public;
-- No direct table policies are created: the client can only use the
-- key-checking functions below. Keep service_role key on the server.

create or replace function public.wotr_create_room(p_initial_state jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_id uuid;
    v_key text;
begin
    if auth.uid() is null then
        raise exception 'Please sign in anonymously before creating a room';
    end if;
    if p_initial_state is null or jsonb_typeof(p_initial_state) <> 'object'
        or jsonb_typeof(p_initial_state->'regions') <> 'array'
        or jsonb_typeof(p_initial_state->'history') <> 'array' then
        raise exception 'Invalid game state';
    end if;
    if pg_column_size(p_initial_state) > 500000 then
        raise exception 'Game state exceeds size limit';
    end if;
    v_key := encode(gen_random_bytes(24), 'hex');
    insert into public.wotr_rooms(secret_hash, game_state)
        values (crypt(v_key, gen_salt('bf', 10)), p_initial_state)
        returning id into v_id;
    return jsonb_build_object('room_id', v_id, 'room_key', v_key, 'revision', 1);
end;
$$;

create or replace function public.wotr_get_room(p_room_id uuid, p_room_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_row public.wotr_rooms%rowtype;
begin
    if auth.uid() is null then
        raise exception 'Authentication required';
    end if;
    select * into v_row from public.wotr_rooms
       where id = p_room_id and secret_hash = crypt(p_room_key, secret_hash);
    if not found then
        raise exception 'Room not found or access key incorrect';
    end if;
    return jsonb_build_object('game_state', v_row.game_state,
                              'revision', v_row.revision,
                              'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.wotr_save_room(
    p_room_id uuid, p_room_key text, p_expected_revision bigint,
    p_game_state jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
    v_revision bigint;
begin
    if auth.uid() is null then
        raise exception 'Authentication required';
    end if;
    if p_game_state is null or jsonb_typeof(p_game_state) <> 'object'
       or jsonb_typeof(p_game_state->'regions') <> 'array'
       or jsonb_typeof(p_game_state->'history') <> 'array' then
        raise exception 'Invalid game state';
    end if;
    if pg_column_size(p_game_state) > 500000 then
        raise exception 'Game state exceeds size limit';
    end if;
    update public.wotr_rooms
       set game_state = p_game_state, revision = revision + 1,
           updated_at = now()
     where id = p_room_id and secret_hash = crypt(p_room_key, secret_hash)
       and revision = p_expected_revision
    returning revision into v_revision;
    if found then
        return jsonb_build_object('status', 'saved', 'revision', v_revision);
    end if;
    if exists (
        select 1 from public.wotr_rooms
        where id = p_room_id and secret_hash = crypt(p_room_key, secret_hash)
    ) then
        return jsonb_build_object('status', 'conflict');
    end if;
    raise exception 'Room not found or access key incorrect';
end;
$$;

revoke all on function public.wotr_create_room(jsonb) from public, anon;
revoke all on function public.wotr_get_room(uuid, text) from public, anon;
revoke all on function public.wotr_save_room(uuid, text, bigint, jsonb) from public, anon;
grant execute on function public.wotr_create_room(jsonb) to authenticated;
grant execute on function public.wotr_get_room(uuid, text) to authenticated;
grant execute on function public.wotr_save_room(uuid, text, bigint, jsonb) to authenticated;

-- Supabase Auth must have Anonymous Sign-Ins enabled.
-- The frontend should use only a publishable/anon key; never service_role.
-- Room URLs include a randomly generated access key in the #fragment.
-- Revision checks avoid silently overwriting another player's move.
