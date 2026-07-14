class ItemSerializer < ActiveModel::Serializer
  attributes :id, :code, :has_comments, :variety, :starred, :bullhorned, :rating, :tag_ids,
    :taken, :comment_count, :first_comment, :source

  def has_comments
    object.comments.any?
  end

  def comment_count
    object.comments.size
  end

  def first_comment
    comment = object.comments.min_by { |c| c.created_at || Time.at(0) }
    return unless comment
    {
      text: comment.text,
      username: comment.user&.name,
      created_at: comment.created_at,
    }
  end

  def source
    source = object.sources.first
    return unless source
    {
      label: source.label,
      user_name: source.user&.name,
    }
  end

  def starred
    if scope
      object.stars.select { |_| _.user_id == scope.id }.any?
    else
      false
    end
  end

  def bullhorned
    if scope
      object.bullhorns.select { |_| _.user_id == scope.id }.any?
    else
      false
    end
  end

  def rating
    if scope
      # Rating should already be loaded from database using "includes", so
      # don't use a "where" here or rails will run another query

      rating = object.ratings.to_a.select{ |rating| rating.user_id == scope.id }.first
      rating.value if rating
    end
  end
end
