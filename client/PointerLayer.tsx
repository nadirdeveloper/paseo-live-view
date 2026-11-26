import { Icon } from "@getpaseo/plugin/client/ui";
import { createContext, useContext, useEffect, useRef, type RefObject } from "react";
import { Animated, Easing, View } from "react-native";
import type { PointerTarget } from "./logic/pointer";
import type { Theme } from "./style";

/** A view the pointer can travel to, plus the editor's gutter width for column maths. */
export type PointerSpot = { view: View; gutter?: number };
export type PointerRegistry = Map<string, PointerSpot>;
type Register = (id: string, view: View | null, gutter?: number) => void;

const noop: Register = () => {};
export const PointerContext = createContext<Register>(noop);

/** Ref callback that registers a view under `id` for the pointer overlay. */
export function usePointerSpot(id: string | null, gutter?: number) {
  const register = useContext(PointerContext);
  return (view: View | null) => {
    if (id) register(id, view, gutter);
  };
}

export function createRegister(registry: PointerRegistry): Register {
  return (id, view, gutter) => {
    if (view) registry.set(id, { view, gutter });
    else registry.delete(id);
  };
}

/** Width of one character in the editor's 12 px monospace font. */
const CHAR_WIDTH = 7.2;

function spotId(target: PointerTarget): string {
  if (target.kind === "tree") return `tree:${target.path}`;
  if (target.kind === "editor") return "editor:line";
  return `terminal:${target.key}`;
}

type Props = { theme: Theme; target: PointerTarget | null; rootRef: RefObject<View | null>; registry: PointerRegistry };

/** A mouse pointer that glides to whatever the agent is working on. Purely decorative. */
export function PointerLayer({ theme, target, rootRef, registry }: Props) {
  const position = useRef(new Animated.ValueXY({ x: 40, y: 40 })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const lastArea = useRef<string | null>(null);
  const lastClick = useRef(false);

  const id = target ? spotId(target) : null;
  const column = target?.kind === "editor" ? target.column : 0;
  const line = target?.kind === "editor" ? target.line : 0;
  const click = target?.kind === "tree" && target.click;

  useEffect(() => {
    if (!target || !id) return;
    const spot = registry.get(id);
    const root = rootRef.current;
    if (!spot || !root) return; // not on screen (scrolled away): stay put
    let cancelled = false;
    // Wait a frame so the target has its final layout after this render.
    const frame = setTimeout(() => {
      root.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
        spot.view.measureInWindow((x, y, width, height) => {
          if (cancelled || (width === 0 && height === 0)) return;
          const offsetX =
            target.kind === "editor" ? (spot.gutter ?? 40) + Math.min(column, 120) * CHAR_WIDTH + 2 : Math.min(48, width / 3);
          const toX = Math.max(0, Math.min(rootWidth - 16, x - rootX + offsetX));
          const toY = Math.max(0, Math.min(rootHeight - 16, y - rootY + height / 2));
          const area = target.kind === "editor" ? `editor:${line}` : id;
          const sameArea = lastArea.current?.split(":")[0] === area.split(":")[0] && target.kind === "editor";
          lastArea.current = area;
          Animated.parallel([
            Animated.timing(position, {
              toValue: { x: toX, y: toY },
              duration: sameArea ? 80 : 350,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: false,
            }),
            Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: false }),
          ]).start();
        });
      });
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(frame);
    };
  }, [id, line, column, target?.kind]);

  // A small press when the pointer "clicks" the file.
  useEffect(() => {
    if (click && !lastClick.current) {
      Animated.sequence([
        Animated.timing(scale, { toValue: 0.75, duration: 90, useNativeDriver: false }),
        Animated.timing(scale, { toValue: 1, duration: 140, useNativeDriver: false }),
      ]).start();
    }
    lastClick.current = click;
  }, [click]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        opacity,
        transform: [{ translateX: position.x }, { translateY: position.y }, { scale }],
      }}
    >
      <Icon name="MousePointer2" size={20} color={theme.colors.foreground} />
    </Animated.View>
  );
}
