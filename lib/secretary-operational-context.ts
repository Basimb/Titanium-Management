/** Read-only projection of the ALREADY authorized snapshot. Never queries or expands scope. */
export function secretaryOperationalContext(
  actor: { id: string; name: string; role: string; department?: string | null },
  tasks: Array<{ id: string; title: string; status: string; priority: string; details?: string; owner?: string | null; suggestedOwner?: string | null; dueDate?: string | null; updatedAt?: number | null }>,
) {
  return {
    actor: { id: actor.id, name: actor.name, role: actor.role, department: actor.department ?? null },
    tasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, priority: task.priority,
      details: (task.details ?? '').slice(0, 400), ownerName: task.owner ?? null,
      suggestedOwnerName: task.suggestedOwner ?? null, dueDate: task.dueDate ?? null,
      updatedAt: task.updatedAt ?? null })),
  };
}
