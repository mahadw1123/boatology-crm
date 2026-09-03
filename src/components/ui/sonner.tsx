import * as React from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-white group-[.toaster]:text-ink group-[.toaster]:border-border group-[.toaster]:shadow-cardHover",
          description: "group-[.toast]:text-ink-light",
          actionButton: "group-[.toast]:bg-navy group-[.toast]:text-white",
          cancelButton: "group-[.toast]:bg-surface-muted group-[.toast]:text-ink",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
