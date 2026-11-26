import { useMemo, useRef } from "react";
import { PanResponder, View, type ViewStyle } from "react-native";
import type { Theme } from "./style";

type Props = {
  theme: Theme;
  /** "column" resizes widths (a vertical bar); "row" resizes heights (a horizontal bar). */
  direction: "column" | "row";
  /** Current size of the pane being resized, in px. */
  size: number;
  min: number;
  max: number;
  /** +1 when dragging right/down grows the pane, -1 when it shrinks it. */
  sign?: 1 | -1;
  onResize(size: number): void;
};

/** A thin draggable bar between two panes. Works with mouse and touch. */
export function Splitter({ theme, direction, size, min, max, sign = 1, onResize }: Props) {
  const start = useRef(size);
  const latest = useRef({ size, min, max, sign, onResize });
  latest.current = { size, min, max, sign, onResize };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          start.current = latest.current.size;
        },
        onPanResponderMove: (_e, g) => {
          const { min: lo, max: hi, sign: s, onResize: resize } = latest.current;
          const delta = (direction === "column" ? g.dx : g.dy) * s;
          resize(Math.max(lo, Math.min(hi, start.current + delta)));
        },
      }),
    [direction],
  );
  const isColumn = direction === "column";
  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={isColumn ? "Resize width" : "Resize height"}
      style={[
        {
          width: isColumn ? 6 : undefined,
          height: isColumn ? undefined : 6,
          alignSelf: "stretch",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface1,
        },
        // Web only: a resize cursor on desktop (React Native's types only list a few cursors).
        { cursor: isColumn ? "col-resize" : "row-resize" } as unknown as ViewStyle,
      ]}
    >
      <View
        style={{
          width: isColumn ? 2 : 28,
          height: isColumn ? 28 : 2,
          borderRadius: 1,
          backgroundColor: theme.colors.border,
        }}
      />
    </View>
  );
}
