import { redirect } from 'next/navigation';

// The viewer lives at /review (it will grow ?repo=&base= params with the
// local git diff source). The root route just forwards there.
export default function HomePage() {
  redirect('/review');
}
