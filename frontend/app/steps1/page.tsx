import { redirect } from "next/navigation";

export default function StepsEntryPage() {
  redirect("/sendspark?step=contacts");
}
