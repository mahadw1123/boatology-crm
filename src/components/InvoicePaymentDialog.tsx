import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors";

let stripePromiseCache: Promise<Stripe | null> | null = null;
function getStripePromise(publishableKey: string) {
  if (!stripePromiseCache) {
    stripePromiseCache = loadStripe(publishableKey);
  }
  return stripePromiseCache;
}

function CheckoutForm({ onSuccess }: { onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setIsSubmitting(true);
    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
      });

      if (error) {
        showErrorToast(error, "Payment was not completed. Check the card details or try another payment method.");
        return;
      }

      if (paymentIntent?.status === "succeeded") {
        toast.success("Payment successful. The invoice will update after Stripe confirms the payment.");
        onSuccess();
      } else {
        toast.info("Payment is processing. Return to Invoices and refresh later if the status does not update immediately.");
      }
    } catch (error) {
      showErrorToast(error, "Stripe could not be reached. Check your connection, close this payment window, and try again from Invoices.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      <Button type="submit" className="w-full bg-[#0c1e38] hover:bg-[#0c1e38]/90" disabled={!stripe || isSubmitting}>
        {isSubmitting ? "Processing..." : "Pay now"}
      </Button>
    </form>
  );
}

export function InvoicePaymentDialog({
  invoiceId,
  open,
  onOpenChange,
  onPaid,
}: {
  invoiceId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [publishableKey, setPublishableKey] = useState<string | null>(null);

  const createIntentMutation = trpc.invoices.createPaymentIntent.useMutation({
    onSuccess: (data) => {
      setClientSecret(data.clientSecret);
      setPublishableKey(data.publishableKey);
    },
    onError: (err) => {
      showErrorToast(err);
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (open && invoiceId) {
      setClientSecret(null);
      createIntentMutation.mutate({ invoiceId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay Invoice</DialogTitle>
        </DialogHeader>
        {!clientSecret || !publishableKey ? (
          <div className="flex h-40 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-ocean border-t-transparent" />
          </div>
        ) : (
          <Elements stripe={getStripePromise(publishableKey)} options={{ clientSecret }}>
            <CheckoutForm
              onSuccess={() => {
                onOpenChange(false);
                onPaid();
              }}
            />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}
