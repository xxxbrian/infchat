import { useMemo, useRef } from 'react';
import { PanResponder } from 'react-native';

type PullExpandResponderOptions = {
  collapseOffset: number;
  expandOffset: number;
  isExpanded: () => boolean;
  onCollapse: () => void;
  onExpand: () => void;
  scrollOffset: () => number;
};

export function usePullExpandResponder({
  collapseOffset,
  expandOffset,
  isExpanded,
  onCollapse,
  onExpand,
  scrollOffset,
}: PullExpandResponderOptions) {
  const dragY = useRef(0);

  return useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gestureState) =>
          scrollOffset() <= 0 &&
          gestureState.dy > 4 &&
          Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
        onPanResponderGrant: () => {
          dragY.current = 0;
        },
        onPanResponderMove: (_event, gestureState) => {
          dragY.current = gestureState.dy;
          if (!isExpanded() && -dragY.current <= expandOffset) {
            onExpand();
          }
          if (isExpanded() && -dragY.current >= collapseOffset) {
            onCollapse();
          }
        },
        onPanResponderRelease: () => {
          if (isExpanded() && dragY.current < Math.abs(expandOffset)) {
            onCollapse();
          }
          dragY.current = 0;
        },
        onPanResponderTerminate: () => {
          dragY.current = 0;
        },
      }),
    [collapseOffset, expandOffset, isExpanded, onCollapse, onExpand, scrollOffset],
  );
}
