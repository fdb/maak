import { type JSX, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type Me, api } from "./api";
import { type Lang, setLang, t } from "./i18n";
import { initTheme } from "./look";
import { Account, Admin, CopyPage, Front, Projects, Report, TextPage } from "./pages";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import { A, loadPart } from "./ui";

function pickLang(me: Me): Lang {
  const own = me.user?.lang ?? localStorage.getItem("maak:lang") ?? navigator.language;
  return own.toLowerCase().startsWith("nl") ? "nl" : "en";
}

type EditorProps = { me: Me; name: string; readOnly: boolean; missing?: JSX.Element };

/** The editor and CodeMirror load only when a project is opened. */
function EditorPage(props: EditorProps) {
  const [part, setPart] = useState<typeof import("./editor") | null>(null);
  useEffect(() => {
    void loadPart(() => import("./editor")).then(setPart);
  }, []);
  return part ? <part.EditorPage {...props} /> : <p class="center">{t("app.loading")}</p>;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [path, setPath] = useState(location.pathname);
  const [lang, setLangState] = useState<Lang>("nl");

  const loadMe = async () => {
    const next = await api<Me>("GET", "/api/me");
    setLang(pickLang(next));
    setLangState(pickLang(next));
    setMe(next);
  };
  useEffect(() => {
    void loadMe();
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const changeLang = async (next: Lang) => {
    try {
      localStorage.setItem("maak:lang", next);
    } catch {
      // A private window may refuse storage. The choice then lasts for this visit.
    }
    if (me?.user) await api("PATCH", "/api/me", { lang: next }).catch(() => null);
    setLang(next);
    setLangState(next);
    if (me?.user) setMe({ ...me, user: { ...me.user, lang: next } });
  };

  if (!me) return <p class="center">{t("app.loading")}</p>;

  const [, first, second] = path.split("/");
  const name = decodeURIComponent(second ?? "");
  const signIn = <Front me={me} next={path} lang={lang} onLang={changeLang} />;

  let page;
  if (first === "" || first === "projects") page = me.user ? <Projects key="list" me={me} trash={false} lang={lang} onLang={changeLang} /> : signIn;
  else if (first === "trash") page = me.user ? <Projects key="trash" me={me} trash={true} lang={lang} onLang={changeLang} /> : signIn;
  // Signed out, a shared project goes on to its code view; any other name shows the sign-in.
  else if (first === "e" && name) page = <EditorPage me={me} name={name} readOnly={false} missing={me.user ? undefined : signIn} />;
  else if (first === "p" && name) page = <EditorPage me={me} name={name} readOnly={true} />;
  else if (first === "copy" && name) page = me.user ? <CopyPage name={name} /> : signIn;
  else if (first === "account") page = me.user ? <Account me={me} lang={lang} onLang={changeLang} /> : signIn;
  else if (first === "admin") page = me.user?.admin ? <Admin me={me} /> : signIn;
  else if (first === "report") page = <Report />;
  else if (first === "about" || first === "terms" || first === "privacy") page = <TextPage which={first} me={me} />;
  else
    page = (
      <main class="page">
        <p>{t("app.notFound")}</p>
        <A href="/">{t("app.back")}</A>
      </main>
    );
  // The language is part of the key, so a switch redraws every text.
  return <div key={lang}>{page}</div>;
}

initTheme();

render(<App />, document.getElementById("app")!);
