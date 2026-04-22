-- Bump prompt_presets models from the deprecated gemini-1.5 family to 2.5.
-- As of 2026-04-22 the `gemini-1.5-flash` / `gemini-1.5-pro` endpoints return
-- 404 on v1beta. The staff-classifier call was failing at runtime and
-- fail-open'ing every entry as 'person' — all three drive prompts would hit
-- the same failure the first time they ran.
--
-- Mapping:
--   gemini-1.5-flash → gemini-2.5-flash   (cheap, fast — good for classification)
--   gemini-1.5-pro   → gemini-2.5-pro     (reasoning — good for extraction/distillation)
--
-- Both are current stable models per ListModels on the v1beta API.

UPDATE "prompt_presets" SET "model" = 'gemini-2.5-flash' WHERE "model" = 'gemini-1.5-flash';
UPDATE "prompt_presets" SET "model" = 'gemini-2.5-pro'   WHERE "model" = 'gemini-1.5-pro';
