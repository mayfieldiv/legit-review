import { ReviewUI } from '../_components/ReviewUI';

// Local branch review viewer. Currently renders the bundled fixture patch
// served by /api/diff; the local `git diff` source replaces it next, at which
// point this route reads ?repo= and ?base= search params.
export default function ReviewPage() {
  return (
    <div className="flex h-dvh flex-col gap-2">
      <ReviewUI path="sample" />
    </div>
  );
}
