import {
  Dialog,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from "@/browser/components/Dialog/Dialog";

interface ImageLightboxProps {
  src: string | null;
  title: string;
  alt: string;
  onClose: () => void;
}

export function ImageLightbox(props: ImageLightboxProps) {
  return (
    <Dialog open={props.src !== null} onOpenChange={props.onClose}>
      <DialogContent
        maxWidth="90vw"
        maxHeight="90vh"
        className="flex w-auto items-center justify-center bg-black/90 p-2"
      >
        <VisuallyHidden>
          <DialogTitle>{props.title}</DialogTitle>
        </VisuallyHidden>
        {props.src && (
          <img src={props.src} alt={props.alt} className="max-h-[85vh] max-w-full object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
