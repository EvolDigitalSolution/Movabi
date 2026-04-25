import { Router, Request, Response } from "express";
import Stripe from "stripe";
import {
  createConnectAccount,
  createOnboardingLink,
  createLoginLink
} from "../services/stripe.service";
import { getSupabaseAdmin } from "../services/supabase.service";
import { EventService } from "../services/event.service";

const router = Router();
const supabase = getSupabaseAdmin();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  console.warn("[connect.routes] STRIPE_SECRET_KEY is not set. Stripe account status route will fail until it is configured.");
}

const stripe = new Stripe(stripeSecretKey || "sk_test_placeholder", {
  apiVersion: "2022-11-15"
});

/**
 * Create a Stripe Connect account for a driver
 */
router.post("/create-account", async (req: Request, res: Response) => {
  try {
    const { userId, email, tenantId } = req.body;

    if (!userId || !email || !tenantId) {
      return res.status(400).json({ error: "userId, email, and tenantId required" });
    }

    const { data: existingAccount, error: existingAccountError } = await supabase
      .from("driver_accounts")
      .select("stripe_account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (existingAccountError) {
      throw existingAccountError;
    }

    if (existingAccount?.stripe_account_id) {
      return res.json({ stripe_account_id: existingAccount.stripe_account_id });
    }

    const account = await createConnectAccount(userId, email);

    const { error } = await supabase
      .from("driver_accounts")
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        stripe_account_id: account.id
      });

    if (error) {
      throw error;
    }

    await EventService.logEvent(
      "connect_account_created",
      { userId, accountId: account.id },
      tenantId,
      userId
    );

    return res.json({ stripe_account_id: account.id });
  } catch (error) {
    console.error("Create Connect Account Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create Stripe Connect account"
    });
  }
});

/**
 * Get onboarding link
 */
router.post("/onboarding-link", async (req: Request, res: Response) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;

    if (!accountId) {
      return res.status(400).json({ error: "accountId required" });
    }

    const link = await createOnboardingLink(accountId, returnUrl, refreshUrl);
    return res.json(link);
  } catch (error) {
    console.error("Onboarding Link Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create onboarding link"
    });
  }
});

/**
 * Get dashboard link
 */
router.post("/dashboard-link", async (req: Request, res: Response) => {
  try {
    const { accountId } = req.body;

    if (!accountId) {
      return res.status(400).json({ error: "accountId required" });
    }

    const link = await createLoginLink(accountId);
    return res.json(link);
  } catch (error) {
    console.error("Dashboard Link Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create dashboard link"
    });
  }
});

/**
 * Get Stripe account status
 */
router.get("/account-status/:accountId", async (req: Request, res: Response) => {
  try {
    const rawAccountId = req.params.accountId;
    const accountId = Array.isArray(rawAccountId) ? rawAccountId[0] : rawAccountId;

    if (!accountId) {
      return res.status(400).json({ error: "accountId is required" });
    }

    if (!stripeSecretKey) {
      return res.status(500).json({ error: "Stripe is not configured on the server" });
    }

    const account = await stripe.accounts.retrieve(accountId);

    return res.json({
      id: account.id,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: account.requirements,
      country: account.country,
      default_currency: account.default_currency,
      email: account.email,
      type: account.type
    });
  } catch (error) {
    console.error("Error fetching account status:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch account status"
    });
  }
});

export default router;
