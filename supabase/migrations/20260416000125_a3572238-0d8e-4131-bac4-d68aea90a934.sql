
-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  credit_balance INTEGER NOT NULL DEFAULT 100 CHECK (credit_balance >= 0),
  region TEXT NOT NULL DEFAULT 'EG',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Credit transactions ledger
CREATE TABLE public.credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reserve', 'deduct', 'refund')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'failed')),
  store TEXT,
  query TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions" ON public.credit_transactions FOR SELECT USING (auth.uid() = user_id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Atomic credit reservation (stateless: single query, no held connections)
CREATE OR REPLACE FUNCTION public.reserve_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_store TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_id UUID;
  v_balance INTEGER;
BEGIN
  -- Lock row and check balance atomically
  UPDATE profiles SET credit_balance = credit_balance - p_amount
  WHERE user_id = p_user_id AND credit_balance >= p_amount
  RETURNING credit_balance INTO v_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, status, store, query)
  VALUES (p_user_id, p_amount, 'reserve', 'pending', p_store, p_query)
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;

-- Settle: adjust reserved amount to actual, refund difference
CREATE OR REPLACE FUNCTION public.settle_credits(
  p_tx_id UUID,
  p_actual_cost INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_reserved INTEGER;
  v_refund INTEGER;
BEGIN
  SELECT user_id, amount INTO v_user_id, v_reserved
  FROM credit_transactions WHERE id = p_tx_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found or already settled';
  END IF;

  v_refund := v_reserved - p_actual_cost;

  -- Refund unused credits
  IF v_refund > 0 THEN
    UPDATE profiles SET credit_balance = credit_balance + v_refund WHERE user_id = v_user_id;
  END IF;

  -- Mark settled
  UPDATE credit_transactions SET status = 'settled', amount = p_actual_cost WHERE id = p_tx_id;

  -- Log refund if any
  IF v_refund > 0 THEN
    INSERT INTO credit_transactions (user_id, amount, type, status, store, query)
    SELECT v_user_id, v_refund, 'refund', 'settled', store, query
    FROM credit_transactions WHERE id = p_tx_id;
  END IF;
END;
$$;
