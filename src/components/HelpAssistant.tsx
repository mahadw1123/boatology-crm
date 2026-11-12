import { useEffect, useRef, useState } from "react";
import { HelpCircle, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { showErrorToast } from "@/lib/errors";

type Turn = { role: "user" | "assistant"; text: string };

const SUGGESTIONS = ["How do I create a quote?", "How do I invoice a job?", "How does the deposit work?"];

/** Staff-only help chat. Answers come from a built-in guide; it sees no CRM data. */
export function HelpAssistant({ aboveMobileNav = false }: { aboveMobileNav?: boolean }) {
  // The technician screen has a bottom tab bar on phones; sit above it there.
  const bottom = aboveMobileNav ? "bottom-20 md:bottom-5" : "bottom-5";
  const statusQuery = trpc.assistant.status.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const askMutation = trpc.assistant.ask.useMutation({
    onSuccess: (data) => setTurns((prev) => [...prev, { role: "assistant", text: data.answer }]),
    onError: (err) => showErrorToast(err),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, askMutation.isPending]);

  if (!statusQuery.data?.enabled) return null;

  const send = (text: string) => {
    const question = text.trim();
    if (!question || askMutation.isPending) return;
    const next = [...turns, { role: "user" as const, text: question }];
    setTurns(next);
    setInput("");
    askMutation.mutate({ messages: next.slice(-10) });
  };

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`fixed ${bottom} right-5 z-40 flex h-11 items-center gap-2 rounded-full bg-[#0c1e38] px-4 text-sm font-medium text-white shadow-lg hover:bg-[#0c1e38]/90`}
        >
          <HelpCircle className="h-4 w-4" />
          Help
        </button>
      )}
      {open && (
        <div className={`fixed ${bottom} right-5 z-40 flex h-[28rem] max-h-[calc(100vh-6rem)] w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col rounded-xl border border-slate-200 bg-white shadow-xl`}>
          <div className="flex items-center justify-between rounded-t-xl bg-[#0c1e38] px-4 py-3 text-white">
            <span className="text-sm font-semibold">CRM Help</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close help">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
            {turns.length === 0 && (
              <div className="space-y-2">
                <p className="text-slate-700">Ask how to use the CRM. I can't see or change any customer or job data.</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-slate-700 hover:bg-slate-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    turn.role === "user"
                      ? "max-w-[85%] whitespace-pre-wrap rounded-lg bg-[#0c1e38] px-3 py-2 text-white"
                      : "max-w-[85%] whitespace-pre-wrap rounded-lg bg-slate-100 px-3 py-2 text-slate-800"
                  }
                >
                  {turn.text}
                </div>
              </div>
            ))}
            {askMutation.isPending && <div className="text-slate-500">Thinking...</div>}
            <div ref={endRef} />
          </div>
          <form
            className="flex gap-2 border-t border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1000}
              placeholder="Type your question"
              className="h-9 flex-1 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
            />
            <Button type="submit" size="icon" className="h-9 w-9 bg-[#0c1e38] hover:bg-[#0c1e38]/90" disabled={askMutation.isPending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
