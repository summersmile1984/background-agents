"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { PromptSkillSuggestionPanel } from "@/components/prompt-skill-suggestion-panel";
import {
  applySkillCompletion,
  filterSkillSuggestions,
  findActiveSkillCompletion,
  type PromptSkillSuggestion,
  type PromptSkillSuggestionSource,
} from "@/lib/prompt-skill-completion";
import type { RuntimeCommandOption } from "@open-inspect/shared/types/runtime-launch";
import {
  applyCommandCompletion,
  filterCommandSuggestions,
  findActiveCommandCompletion,
} from "@/lib/prompt-command-completion";

type Cursor = { start: number; end: number };

function sameCursor(left: Cursor, right: Cursor): boolean {
  return left.start === right.start && left.end === right.end;
}

type PromptSkillTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "defaultValue" | "onChange" | "value"
> & {
  value: string;
  suggestions: PromptSkillSuggestionSource;
  commands?: readonly RuntimeCommandOption[];
  onValueChange: (value: string) => void;
};

function cursorFromInput(input: HTMLTextAreaElement): Cursor {
  return { start: input.selectionStart, end: input.selectionEnd };
}

export const PromptSkillTextarea = forwardRef<HTMLTextAreaElement, PromptSkillTextareaProps>(
  function PromptSkillTextarea(
    {
      value,
      suggestions: suggestionSource,
      commands = [],
      onValueChange,
      disabled = false,
      maxLength,
      onBlur,
      onClick,
      onCompositionEnd,
      onCompositionStart,
      onFocus,
      onKeyDown,
      onKeyUp,
      onSelect,
      ...textareaProps
    },
    forwardedRef
  ) {
    const [cursor, setCursor] = useState<Cursor | null>(null);
    const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
    const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
    const [dismissedAt, setDismissedAt] = useState<{ value: string; cursor: Cursor } | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const instanceId = useId();
    const listboxId = `${instanceId}-skill-listbox`;
    const commandListboxId = `${instanceId}-command-listbox`;
    const optionId = (skillId: string) => `${instanceId}-skill-option-${skillId}`;
    const skills = suggestionSource.status === "ready" ? suggestionSource.skills : [];
    const completion = cursor ? findActiveSkillCompletion(value, cursor.start, cursor.end) : null;
    const commandCompletion = cursor
      ? findActiveCommandCompletion(value, cursor.start, cursor.end)
      : null;
    const matchingSkills = filterSkillSuggestions(skills, completion);
    const activeSkill =
      matchingSkills.find((skill) => skill.skillId === activeSkillId) ?? matchingSkills[0];
    const matchingCommands = filterCommandSuggestions(commands, commandCompletion);
    const activeCommand =
      matchingCommands.find((command) => command.id === activeCommandId) ?? matchingCommands[0];
    const dismissed =
      dismissedAt !== null &&
      dismissedAt.value === value &&
      cursor !== null &&
      sameCursor(dismissedAt.cursor, cursor);
    const open = completion !== null && !dismissed;
    const commandOpen = commandCompletion !== null && !dismissed;

    const setInputRef = useCallback(
      (input: HTMLTextAreaElement | null) => {
        inputRef.current = input;
        if (typeof forwardedRef === "function") forwardedRef(input);
        else if (forwardedRef) forwardedRef.current = input;
      },
      [forwardedRef]
    );

    const skillIdsAt = (nextValue: string, nextCursor: Cursor): string[] => {
      const nextCompletion = findActiveSkillCompletion(nextValue, nextCursor.start, nextCursor.end);
      return filterSkillSuggestions(skills, nextCompletion).map((skill) => skill.skillId);
    };

    const syncInput = (input: HTMLTextAreaElement, reopen = false) => {
      const nextCursor = cursorFromInput(input);
      const skillIds = skillIdsAt(input.value, nextCursor);
      const commandIds = filterCommandSuggestions(
        commands,
        findActiveCommandCompletion(input.value, nextCursor.start, nextCursor.end)
      ).map((command) => command.id);
      setCursor(nextCursor);
      setActiveSkillId((current) =>
        current !== null && skillIds.includes(current) ? current : (skillIds[0] ?? null)
      );
      setActiveCommandId((current) =>
        current !== null && commandIds.includes(current) ? current : (commandIds[0] ?? null)
      );
      setDismissedAt((current) =>
        !reopen && current?.value === input.value && sameCursor(current.cursor, nextCursor)
          ? current
          : null
      );
    };

    useEffect(() => {
      if (commandOpen && activeCommand) {
        listRef.current
          ?.querySelector(`[data-command-id="${activeCommand.id}"]`)
          ?.scrollIntoView?.({ block: "nearest" });
      } else if (open && activeSkill) {
        listRef.current
          ?.querySelector(`[data-skill-id="${activeSkill.skillId}"]`)
          ?.scrollIntoView?.({ block: "nearest" });
      }
    }, [activeCommand, activeSkill, commandOpen, open]);

    const selectSkill = (skill: PromptSkillSuggestion) => {
      if (!completion || !cursor) return;
      const next = applySkillCompletion(value, completion, skill.name, maxLength);
      if (!next) {
        setDismissedAt({ value, cursor });
        return;
      }
      onValueChange(next.value);
      setCursor({ start: next.caret, end: next.caret });
      setActiveSkillId(null);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
      });
    };

    const selectCommand = (command: RuntimeCommandOption) => {
      const next = applyCommandCompletion(command, maxLength);
      if (!next) return;
      onValueChange(next.value);
      setCursor({ start: next.caret, end: next.caret });
      setActiveCommandId(null);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || composingRef.current) {
        onKeyDown?.(event);
        return;
      }
      const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (commandOpen && activeCommand && unmodified && event.key === "ArrowDown") {
        event.preventDefault();
        const index = Math.max(0, matchingCommands.indexOf(activeCommand));
        setActiveCommandId(matchingCommands[(index + 1) % matchingCommands.length].id);
        return;
      }
      if (commandOpen && activeCommand && unmodified && event.key === "ArrowUp") {
        event.preventDefault();
        const index = Math.max(0, matchingCommands.indexOf(activeCommand));
        setActiveCommandId(
          matchingCommands[(index - 1 + matchingCommands.length) % matchingCommands.length].id
        );
        return;
      }
      if (
        commandOpen &&
        activeCommand &&
        unmodified &&
        (event.key === "Enter" || event.key === "Tab")
      ) {
        event.preventDefault();
        if (activeCommand.available) selectCommand(activeCommand);
        return;
      }
      if (commandOpen && event.key === "Escape" && cursor) {
        event.preventDefault();
        setDismissedAt({ value, cursor });
        return;
      }
      if (open && activeSkill && unmodified && event.key === "ArrowDown") {
        event.preventDefault();
        const index = Math.max(0, matchingSkills.indexOf(activeSkill));
        setActiveSkillId(matchingSkills[(index + 1) % matchingSkills.length].skillId);
        return;
      }
      if (open && activeSkill && unmodified && event.key === "ArrowUp") {
        event.preventDefault();
        const index = Math.max(0, matchingSkills.indexOf(activeSkill));
        setActiveSkillId(
          matchingSkills[(index - 1 + matchingSkills.length) % matchingSkills.length].skillId
        );
        return;
      }
      if (open && activeSkill && unmodified && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        selectSkill(activeSkill);
        return;
      }
      if (open && event.key === "Escape" && cursor) {
        event.preventDefault();
        setDismissedAt({ value, cursor });
        return;
      }
      onKeyDown?.(event);
    };

    const activeOptionId = commandOpen
      ? activeCommand
        ? `${instanceId}-command-option-${activeCommand.id}`
        : undefined
      : open && activeSkill
        ? optionId(activeSkill.skillId)
        : undefined;

    return (
      <>
        <textarea
          {...textareaProps}
          ref={setInputRef}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          aria-autocomplete="list"
          aria-expanded={open || commandOpen}
          aria-controls={commandOpen ? commandListboxId : open ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          onBlur={(event) => {
            setCursor(null);
            onBlur?.(event);
          }}
          onChange={(event) => {
            if (!composingRef.current) syncInput(event.currentTarget);
            onValueChange(event.currentTarget.value);
          }}
          onClick={(event) => {
            syncInput(event.currentTarget, true);
            onClick?.(event);
          }}
          onCompositionStart={(event) => {
            composingRef.current = true;
            setCursor(null);
            onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncInput(event.currentTarget, true);
            onCompositionEnd?.(event);
          }}
          onFocus={(event) => {
            syncInput(event.currentTarget, true);
            onFocus?.(event);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (event.key !== "Escape" && !composingRef.current) {
              syncInput(event.currentTarget);
            }
            onKeyUp?.(event);
          }}
          onSelect={(event) => {
            if (!composingRef.current) syncInput(event.currentTarget);
            onSelect?.(event);
          }}
        />
        {open && completion && (
          <PromptSkillSuggestionPanel
            id={listboxId}
            optionId={optionId}
            completion={completion}
            source={suggestionSource}
            matchingSkills={matchingSkills}
            activeSkillId={activeSkill?.skillId}
            listRef={listRef}
            onActivate={setActiveSkillId}
            onSelect={selectSkill}
          />
        )}
        {commandOpen && commandCompletion && (
          <div
            ref={listRef}
            id={commandListboxId}
            role="listbox"
            aria-label="Runtime commands"
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 overflow-y-auto border border-border bg-popover p-1 shadow-lg"
          >
            {matchingCommands.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No matching commands.</div>
            ) : (
              matchingCommands.map((command) => (
                <button
                  key={command.id}
                  id={`${instanceId}-command-option-${command.id}`}
                  type="button"
                  role="option"
                  aria-selected={activeCommand?.id === command.id}
                  aria-disabled={!command.available}
                  data-command-id={command.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveCommandId(command.id)}
                  onClick={() => command.available && selectCommand(command)}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm ${
                    activeCommand?.id === command.id ? "bg-accent-muted" : ""
                  } ${command.available ? "hover:bg-accent-muted" : "cursor-not-allowed opacity-50"}`}
                >
                  <span className="w-20 shrink-0 font-mono text-foreground">
                    /{command.slashName}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-foreground">{command.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {command.available ? command.description : command.unavailableReason}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </>
    );
  }
);
