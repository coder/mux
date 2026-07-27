interface TimelinePanelProps {
  workspaceId: string;
}

export function TimelinePanel(props: TimelinePanelProps) {
  return <div data-workspace-id={props.workspaceId} />;
}
