import { Check, Fish } from "lucide-react";
import { CollectionIcon, ItemIcon } from "@/features/items/item-icon";
import { GAME_ITEMS } from "@/features/game/game-rewards";
import { collectionCount, worldCatalog as catalog, type WorldState } from "./model";
import { DecorationPreview } from "./decoration-preview";
import { WORLD_PRESENTATION } from "./presentation";
import styles from "./world.module.css";

export function WorldCollections({ state, gifts }: { state: WorldState; gifts: readonly string[] }) {
  return <div className={styles.panel}>
    <div className={styles.panelHeading}><span className={styles.eyebrow}>ПАМЯТЬ О ПУТЕШЕСТВИЯХ</span><h2>Коллекции <small>{collectionCount(state.collection)}/{catalog.finds.length}</small></h2><p>Находки остаются навсегда. Новые вылазки пока приносят ресурсы; здесь сохранены находки из прежних путешествий.</p></div>
    {(["forest", "fishing"] as const).map(group => {
      const finds = catalog.finds.filter(find => find.group === group);
      const reward = group === "forest" ? "explorer_cap" : "willow_rod";
      return <section key={group} className={styles.panel}>
        <h3 className={styles.albumHeading}>{group === "forest" ? "Лесной альбом" : "Находки рыболова"}<small>{finds.filter(find => state.collection.includes(find.id)).length}/{finds.length}</small></h3>
        <p className={styles.albumReward}><ItemIcon itemId={reward} size={26} />{group === "forest" ? "Шляпа следопыта" : "Ивовая удочка"}{state.inventory.includes(reward) ? " · получена" : ` · за все ${finds.length} находок`}</p>
        <div className={styles.collection}>{finds.map(find => {
          const owned = state.collection.includes(find.id);
          const fishing = catalog.routes.some(route => route.id.startsWith("fishing_") && route.finds.includes(find.id));
          return <article key={find.id} className={styles.find} data-owned={owned} data-find={find.id}>
            <div className={styles.findArt}><CollectionIcon findId={find.id} size={76} />{owned && <span className={styles.findCheck} aria-hidden="true"><Check size={14} /></span>}</div>
            <h3>{find.name}</h3><p>{find.description}</p><span className={styles.kicker}>{owned ? <><Check size={13} />В альбоме</> : WORLD_PRESENTATION.rebuilding ? "Ещё не найдено" : fishing ? <><Fish size={13} />На рыбалке · любой режим</> : "На лесной прогулке · 5 или 10 мин"}</span>
          </article>;
        })}</div>
      </section>;
    })}
    <p className={styles.hint}>Завершено путешествий: {state.completedJourneys}.</p>
    {WORLD_PRESENTATION.streakDecor && <details className={styles.details}><summary>Подарки Мохлику · {gifts.length}/{GAME_ITEMS.length}</summary>
      <div className={styles.collection}>{GAME_ITEMS.map(item => <article className={styles.find} data-owned={gifts.includes(item.id)} key={item.id}>
        <DecorationPreview item={item.id} /><h3>{item.title}</h3><span className={styles.kicker}>{gifts.includes(item.id) ? (state.hiddenGifts ?? []).includes(item.id) ? "Хранится в коллекции" : "Украшает домик" : `За ${item.days} дней отметок подряд`}</span>
      </article>)}</div>
    </details>}
  </div>;
}
