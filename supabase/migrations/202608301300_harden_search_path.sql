-- Σφίξιμο μετά από έλεγχο ασφαλείας (Supabase advisor).
-- Δεν αλλάζει καμία συμπεριφορά της εφαρμογής.

-- 1. Το unaccent ήταν το μόνο extension στο public. Πάει στο extensions,
--    όπου βρίσκονται ήδη pgcrypto, uuid-ossp, pg_stat_statements.
--    Ελέγχθηκε πρώτα ότι κανένα index δεν εξαρτάται από αυτό.
alter extension unaccent set schema extensions;

-- 2. Καρφωμένο search_path σε κάθε συνάρτηση που δεν είχε.
--    Η normalize_person_name καλεί unaccent() χωρίς πρόθεμα, οπότε χρειάζεται
--    το extensions στη διαδρομή της — αλλιώς θα έσπαγε με τη μετακόμιση.
alter function public.rodios_normalize_person_name(text)
  set search_path = extensions, public, pg_temp;

-- Οι άλλες δύο χρησιμοποιούν μόνο ενσωματωμένες συναρτήσεις της pg_catalog.
alter function public.rodios_touch_updated_at()          set search_path = '';
alter function public.rodios_safe_numeric(text, numeric) set search_path = '';
