export const adjacentTab = (order: string[], key: string) => {
  const index = order.indexOf(key);
  return index < 0 ? null : order[index - 1] || order[index + 1] || null;
};

export const moveTab = (order: string[], from: string, to: string) => {
  const source = order.indexOf(from), target = order.indexOf(to);
  if (source < 0 || target < 0 || source === target) return order;
  const next = [...order];
  next.splice(target, 0, ...next.splice(source, 1));
  return next;
};
