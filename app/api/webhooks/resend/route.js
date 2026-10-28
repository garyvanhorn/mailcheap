import { handleResendRequest } from "@/lib/resend-webhook";

// Deliveries, bounces, complaints, failures and suppressions of every account's emails through Resend.
export function POST(request) {
	return handleResendRequest(request);
}
