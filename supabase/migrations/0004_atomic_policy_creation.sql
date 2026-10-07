BEGIN;

-- One fixed V1 rule; any exception rolls back the entire function call.
CREATE FUNCTION public.create_gender_pay_policy(p_name text, p_threshold numeric)
RETURNS TABLE (policy_id uuid, rule_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  new_policy_id uuid;
  new_rule_id uuid;
BEGIN
  IF p_name IS NULL OR p_name !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'Policy name is required' USING ERRCODE = '22023';
  END IF;
  IF p_threshold IS NULL OR p_threshold::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Threshold must be finite' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.policies (name, user_id, is_active)
    VALUES (btrim(p_name), NULL, false) RETURNING id INTO new_policy_id;
  INSERT INTO public.policy_rules
    (policy_id, criterion, operator, threshold_numeric, threshold_text, action, unknown_handling)
    VALUES (new_policy_id, 'uk_median_gender_pay_gap', '<=', p_threshold, NULL, 'REQUIRE', 'UNKNOWN')
    RETURNING id INTO new_rule_id;
  UPDATE public.policies SET is_active = true WHERE id = new_policy_id;
  RETURN QUERY SELECT new_policy_id, new_rule_id;
END;
$$;

-- Server-side only, matching the existing review RPC access model.
REVOKE ALL ON FUNCTION public.create_gender_pay_policy(text, numeric) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.create_gender_pay_policy(text, numeric) FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.policies, public.policy_rules TO service_role;
    GRANT EXECUTE ON FUNCTION public.create_gender_pay_policy(text, numeric) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
