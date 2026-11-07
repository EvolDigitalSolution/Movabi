-- Install with the server submission endpoint; customer onboarding is unaffected.
create or replace function public.guard_driver_submission_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and new.role = 'driver' then
    if tg_op = 'INSERT' then
      if new.onboarding_completed is true or new.is_verified is true
        or new.verification_status in ('approved','under_review')
        or new.driver_review_status in ('approved','under_review') then
        raise exception using errcode = '42501', message = 'Driver review state is server managed';
      end if;
    elsif (old.role is distinct from new.role and
           (new.onboarding_completed is true or new.is_verified is true
            or new.verification_status in ('approved','under_review')
            or new.driver_review_status in ('approved','under_review')))
       or (new.onboarding_completed is true and old.onboarding_completed is distinct from true)
       or (new.is_verified is true and old.is_verified is distinct from true)
       or (new.verification_status in ('approved','under_review')
           and old.verification_status is distinct from new.verification_status)
       or (new.driver_review_status in ('approved','under_review')
           and old.driver_review_status is distinct from new.driver_review_status) then
      raise exception using errcode = '42501', message = 'Driver review state is server managed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_driver_submission_state on public.profiles;
create trigger guard_driver_submission_state
before insert or update on public.profiles
for each row execute function public.guard_driver_submission_state();
