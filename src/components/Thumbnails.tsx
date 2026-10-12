import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MouseEvent } from "react";
import type { DocState, PageRef } from "../lib/document";
import { PageCanvas } from "./PageCanvas";

const THUMB_WIDTH = 132;

interface Props {
  doc: DocState;
  selected: ReadonlySet<string>;
  current: string | null;
  onSelect: (id: string, e: MouseEvent) => void;
  onOpen: (id: string) => void;
  /** Move the dragged pages so they land before the page at `to`. */
  onMove: (ids: Set<string>, to: number) => void;
}

export function Thumbnails({ doc, selected, current, onSelect, onOpen, onMove }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = doc.pages.findIndex((p) => p.id === active.id);
    const overIndex = doc.pages.findIndex((p) => p.id === over.id);
    // Dragging a selected page carries the whole selection along.
    const ids = selected.has(String(active.id)) ? new Set(selected) : new Set([String(active.id)]);
    onMove(ids, overIndex > from ? overIndex + 1 : overIndex);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={doc.pages.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        <ol className="thumbs" aria-label="Pages">
          {doc.pages.map((page, i) => (
            <Thumb
              key={page.id}
              doc={doc}
              page={page}
              index={i}
              isSelected={selected.has(page.id)}
              isCurrent={current === page.id}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

interface ThumbProps {
  doc: DocState;
  page: PageRef;
  index: number;
  isSelected: boolean;
  isCurrent: boolean;
  onSelect: (id: string, e: MouseEvent) => void;
  onOpen: (id: string) => void;
}

function Thumb({ doc, page, index, isSelected, isCurrent, onSelect, onOpen }: ThumbProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined }}
      className={`thumb${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}${isDragging ? " dragging" : ""}`}
      data-testid="thumb"
      onClick={(e) => {
        onSelect(page.id, e);
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onOpen(page.id);
      }}
      {...attributes}
      {...listeners}
      aria-label={`Page ${index + 1}`}
      aria-selected={isSelected}
    >
      <PageCanvas doc={doc} page={page} width={THUMB_WIDTH} rootMargin="300px" />
      <span className="thumb-label">{index + 1}</span>
    </li>
  );
}
