"""Canonical wallet release preservation checks, evaluated inside disposable restores."""
import re
def preservation_sql(canonical):
    names=set(re.findall(r'CREATE(?: OR REPLACE)? FUNCTION public\.([a-z0-9_]+)\s*\(',canonical,re.I))
    names.update(['freeze_wallet_topup_fee_v1','freeze_wallet_topup_fee_v2'])
    allowed=','.join("'"+name+"'" for name in sorted(names))
    return """SELECT json_build_object(
     'functions',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid::regprocedure::text)::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN('f','p') AND p.proname NOT IN ("""+allowed+""")),'[]')),
     'routes',md5((SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]')::text FROM public.market_payment_routes r)),
     'bookings',md5((SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]')::text FROM public.jobs j)),
     'outbox',md5((SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY job_id),'[]')::text FROM public.job_payout_queue q)),
     'bookingConstraints',md5(coalesce((SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)::text
       FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname IN('jobs','job_payout_queue','driver_earnings','refund_operations')),'[]'))
    )"""
