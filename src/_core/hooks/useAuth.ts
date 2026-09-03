import { trpc } from "@/lib/trpc";

export type AuthUser = {
  id: number;
  name: string | null;
  email: string | null;
  role: "admin" | "management" | "office_staff" | "technician" | "customer";
  employeeId?: number | null;
  customerId?: number | null;
} | null | undefined;

export function useAuth() {
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
  });
  const utils = trpc.useUtils();
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
      window.location.href = "/login";
    },
  });

  return {
    user: meQuery.data as AuthUser,
    isLoading: meQuery.isLoading,
    isAuthenticated: !!meQuery.data,
    logout: () => logoutMutation.mutate(),
  };
}
