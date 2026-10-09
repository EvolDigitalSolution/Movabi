-- Align internal driver acceptance with goods minimum capacity matching.
-- Preserve existing passenger logic and all acceptance/ownership safeguards.
BEGIN;
DO $migration$
DECLARE definition text;
BEGIN
    IF to_regprocedure('public.driver_vehicle_can_accept_job(uuid,uuid)') IS NULL THEN
        RAISE EXCEPTION 'Expected internal vehicle compatibility function missing';
    END IF;
    definition := pg_get_functiondef('public.driver_vehicle_can_accept_job(uuid,uuid)'::regprocedure);
    IF position('v_goods_required_rank' in definition)>0 THEN
        RAISE EXCEPTION 'Goods capacity patch already applied; inspect before retrying';
    END IF;
    IF (length(definition)-length(replace(definition,$anchor$    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN$anchor$,'')))/length($anchor$    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN$anchor$)<>1
       OR position('    v_vehicle_text TEXT;' in definition)=0 THEN
        RAISE EXCEPTION 'Unexpected vehicle compatibility function body';
    END IF;
    definition := replace(definition,'    v_vehicle_text TEXT;',
       '    v_vehicle_text TEXT;
    v_goods_required TEXT;
    v_goods_required_rank integer;
    v_goods_actual_rank integer;');
    definition := replace(definition,$anchor$    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN$anchor$,$branch$    -- Goods class is a minimum carrying capacity, matching API and app.
    IF lower(trim(v_service_slug)) IN ('delivery','errand') THEN
        v_goods_required := lower(coalesce(
            nullif(v_metadata->>'service_vehicle_class',''),
            nullif(v_metadata->>'vehicle_class',''),
            nullif(v_metadata->>'vehicleClass',''),
            nullif(v_metadata #>> '{delivery_details,vehicleClass}',''),
            nullif(v_metadata #>> '{errand_details,vehicleClass}',''), 'car'));
        v_goods_required_rank := CASE
            WHEN v_goods_required ~ 'bike|motorcycle|scooter' THEN 1
            WHEN v_goods_required ~ 'large[_ ]van|luton' THEN 4
            WHEN v_goods_required ~ 'van' THEN 3
            WHEN v_goods_required ~ 'car|standard|minibus|seater|xl' THEN 2
            ELSE 0 END;
        v_goods_actual_rank := CASE
            WHEN v_vehicle_text ~ 'bike|motorcycle|scooter' THEN 1
            WHEN v_vehicle_text ~ 'large[_ ]van|luton' THEN 4
            WHEN v_vehicle_text ~ 'van' THEN 3
            WHEN v_vehicle_text ~ 'car|standard|minibus|seater|xl' THEN 2
            ELSE 0 END;
        RETURN v_goods_required_rank > 0 AND v_goods_actual_rank >= v_goods_required_rank;
    END IF;

    IF v_vehicle_text LIKE '%bike%' OR v_vehicle_text LIKE '%motorcycle%' OR v_vehicle_text LIKE '%scooter%' THEN$branch$);
    EXECUTE definition;
END $migration$;
-- Keep helper internal: only the existing SECURITY DEFINER acceptance RPC invokes it.
REVOKE ALL ON FUNCTION public.driver_vehicle_can_accept_job(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
